import { ethers, UnsignedTransaction } from 'ethers';
import { createNanoEvents, Emitter } from 'nanoevents';
import { Store } from 'store-unit';
import { isTruthy } from 'is-truthy-ts';
import { encrypt, decrypt } from '@metamask/browser-passworder';
import { notificationWindow } from 'src/background/NotificationWindow/NotificationWindow';
import { ChannelContext } from 'src/shared/types/ChannelContext';
import {
  InvalidParams,
  MethodNotImplemented,
  OriginNotAllowed,
  RecordNotFound,
  UserRejected,
  UserRejectedTxSignature,
} from 'src/shared/errors/errors';
import { INTERNAL_ORIGIN } from 'src/background/constants';
import { networksStore } from 'src/modules/networks/networks-store';
import { IncomingTransaction } from 'src/modules/ethereum/types/IncomingTransaction';
import { prepareTransaction } from 'src/modules/ethereum/transactions/prepareTransaction';
import { createChain } from 'src/modules/networks/Chain';
import { getNextAccountPath } from 'src/shared/wallet/getNextAccountPath';
import { hasGasPrice } from 'src/modules/ethereum/transactions/gasPrices/hasGasPrice';
import { fetchAndAssignGasPrice } from 'src/modules/ethereum/transactions/fetchAndAssignGasPrice';
import type { TypedData } from 'src/modules/ethereum/message-signing/TypedData';
import { prepareTypedData } from 'src/modules/ethereum/message-signing/prepareTypedData';
import { toUtf8String } from 'ethers/lib/utils';
import { removeSignature } from 'src/modules/ethereum/transactions/removeSignature';
import { toEthersWallet } from './helpers/toEthersWallet';
import { maskWallet, maskWalletGroup, maskWalletGroups } from './helpers/mask';
import { SeedType } from './model/SeedType';
import type { PendingWallet, WalletRecord } from './model/types';
import {
  MnemonicWalletContainer,
  PrivateKeyWalletContainer,
} from './model/WalletContainer';
import { WalletRecordModel as Model } from './WalletRecord';
import type { WalletStore } from './persistence';
import { walletStore } from './persistence';
import { emitter } from '../events';

type PublicMethodParams<T = undefined> = T extends undefined
  ? {
      context?: Partial<ChannelContext>;
    }
  : {
      params: T;
      context?: Partial<ChannelContext>;
    };

interface WalletEvents {
  recordUpdated: () => void;
  currentAddressChange: (addresses: string[]) => void;
  chainChanged: (chainId: string) => void;
  permissionsUpdated: () => void;
}

export class Wallet {
  public id: string;
  public publicEthereumController: PublicController;
  private encryptionKey: string | null;
  private walletStore: WalletStore;
  private pendingWallet: PendingWallet | null = null;
  private record: WalletRecord | null;

  private store: Store<{ chainId: string }>;

  emitter: Emitter<WalletEvents>;

  constructor(id: string, encryptionKey: string | null) {
    this.store = new Store({ chainId: '0x1' });
    this.emitter = createNanoEvents();

    this.id = id;
    this.walletStore = walletStore;
    this.encryptionKey = encryptionKey;
    this.record = null;

    this.walletStore.ready().then(() => {
      this.syncWithWalletStore();
    });
    Object.assign(window, { encrypt, decrypt });
    this.publicEthereumController = new PublicController(this);
  }

  private async syncWithWalletStore() {
    if (!this.encryptionKey) {
      return;
    }
    await walletStore.ready();
    this.record = await walletStore.read(this.id, this.encryptionKey);
    if (this.record) {
      this.emitter.emit('recordUpdated');
    }
  }

  private async updateWalletStore(record: WalletRecord) {
    if (!this.encryptionKey) {
      throw new Error('Cannot save pending wallet: encryptionKey is null');
    }
    this.walletStore.save(this.id, this.encryptionKey, record);
  }

  async ready() {
    return this.walletStore.ready();
  }

  async getId() {
    return this.id;
  }

  async updateId({ params: id }: PublicMethodParams<string>) {
    this.id = id;
    await walletStore.ready();
    await this.syncWithWalletStore();
  }

  async updateEncryptionKey({ params: key }: PublicMethodParams<string>) {
    this.encryptionKey = key;
    await walletStore.ready();
    await this.syncWithWalletStore();
  }

  async testMethod({ params: value }: PublicMethodParams<number>) {
    return new Promise<string>((r) => setTimeout(() => r(String(value)), 1500));
  }

  // TODO: For now, I prefix methods with "ui" which return wallet data and are supposed to be called
  // from the UI (extension popup) thread. It's maybe better to refactor them
  // into a separate isolated class
  async uiGenerateMnemonic() {
    this.pendingWallet = {
      groupId: null,
      walletContainer: new MnemonicWalletContainer(),
    };
    return maskWallet(this.pendingWallet.walletContainer.getFirstWallet());
  }

  async uiAddMnemonicWallet({
    params: { groupId },
  }: PublicMethodParams<{ groupId: string }>) {
    const group = this.record?.walletManager.groups.find(
      (group) => group.id === groupId
    );
    if (!group) {
      throw new Error(`Group with id ${groupId} not found`);
    }
    if (!group.walletContainer.wallets.length) {
      throw new Error(
        `Existing group is expected to have at least one mnemonic wallet`
      );
    }
    const { wallets } = group.walletContainer;
    const lastMnemonic = wallets[wallets.length - 1].mnemonic;
    if (!lastMnemonic) {
      throw new Error(
        `Existing group is expected to have at least one mnemonic wallet`
      );
    }
    const mnemonic = {
      phrase: lastMnemonic.phrase,
      path: getNextAccountPath(lastMnemonic.path),
    };
    this.pendingWallet = {
      groupId,
      walletContainer: new MnemonicWalletContainer([{ mnemonic }]),
    };
    return maskWallet(this.pendingWallet.walletContainer.getFirstWallet());
  }

  async uiImportPrivateKey({ params: privateKey }: PublicMethodParams<string>) {
    this.pendingWallet = {
      groupId: null,
      walletContainer: new PrivateKeyWalletContainer([{ privateKey }]),
    };
    return maskWallet(this.pendingWallet.walletContainer.getFirstWallet());
  }

  async uiImportSeedPhrase({ params: seedPhrase }: PublicMethodParams<string>) {
    const mnemonic = { phrase: seedPhrase, path: ethers.utils.defaultPath };
    this.pendingWallet = {
      groupId: null,
      walletContainer: new MnemonicWalletContainer([{ mnemonic }]),
    };
    return maskWallet(this.pendingWallet.walletContainer.getFirstWallet());
  }

  async getRecoveryPhrase({
    params: { groupId },
    context,
  }: PublicMethodParams<{ groupId: string }>) {
    this.verifyInternalOrigin(context);
    const group = this.record?.walletManager.groups.find(
      (group) => group.id === groupId
    );
    if (!group) {
      throw new Error('Wallet Group not found');
    }
    return group.walletContainer.getMnemonic();
  }

  async uiGetCurrentWallet({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    if (!this.id) {
      return null;
    }
    const currentAddress = this.readCurrentAddress();
    if (this.record && currentAddress) {
      const wallet = Model.getWalletByAddress(this.record, currentAddress);
      return wallet ? maskWallet(wallet) : null;
    }
    return null;
  }

  async uiGetWalletByAddress({
    context,
    params: { address },
  }: PublicMethodParams<{ address: string }>) {
    this.verifyInternalOrigin(context);
    if (!this.record) {
      throw new RecordNotFound();
    }
    if (!address) {
      throw new Error('Ilegal argument: address is required for this method');
    }
    const wallet = Model.getWalletByAddress(this.record, address);
    return wallet ? maskWallet(wallet) : null;
  }

  async savePendingWallet() {
    if (!this.pendingWallet) {
      throw new Error('Cannot save pending wallet: pendingWallet is null');
    }
    if (!this.encryptionKey) {
      throw new Error('Cannot save pending wallet: encryptionKey is null');
    }
    const record = Model.createOrUpdateRecord(this.record, this.pendingWallet);
    this.record = record;
    this.updateWalletStore(record);
  }

  async acceptOrigin(origin: string, address: string) {
    this.ensureRecord(this.record);
    this.record = Model.addPermission(this.record, { address, origin });
    this.updateWalletStore(this.record);
    this.emitter.emit('permissionsUpdated');
  }

  async removeAllOriginPermissions({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    this.ensureRecord(this.record);
    this.record = Model.removeAllOriginPermissions(this.record);
    this.updateWalletStore(this.record);
    this.emitter.emit('permissionsUpdated');
  }

  async removePermission({
    context,
    params: { origin, address },
  }: PublicMethodParams<{ origin: string; address?: string }>) {
    this.verifyInternalOrigin(context);
    this.ensureRecord(this.record);
    this.record = Model.removePermission(this.record, { origin, address });
  }

  allowedOrigin(
    context: Partial<ChannelContext> | undefined,
    address: string
  ): context is ChannelContext {
    if (!context || !context.origin) {
      throw new Error('This method requires context');
    }
    if (context.origin === INTERNAL_ORIGIN) {
      return true;
    }
    return this.record?.permissions[context.origin]?.includes(address) || false;
  }

  async hasPermission({
    params: { address, origin },
    context,
  }: PublicMethodParams<{ address: string; origin: string }>) {
    this.verifyInternalOrigin(context);
    return this.record?.permissions[origin]?.includes(address) || false;
  }

  async getOriginPermissions({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    this.ensureRecord(this.record);
    return Object.entries(this.record.permissions).map(
      ([origin, addresses]) => ({ origin, addresses })
    );
  }

  async setCurrentAddress({
    params: { address },
    context,
  }: PublicMethodParams<{ address: string }>) {
    this.verifyInternalOrigin(context);
    this.ensureRecord(this.record);
    this.record = Model.setCurrentAddress(this.record, { address });
    this.updateWalletStore(this.record);

    const { currentAddress } = this.record.walletManager;
    this.emitter.emit(
      'currentAddressChange',
      [currentAddress].filter(isTruthy)
    );
  }

  readCurrentAddress() {
    return this.record?.walletManager.currentAddress || null;
  }

  ensureCurrentAddress(): string {
    const currentAddress = this.readCurrentAddress();
    if (!currentAddress) {
      throw new Error('Wallet is not initialized');
    }
    return currentAddress;
  }

  private ensureRecord(
    record: WalletRecord | null
  ): asserts record is WalletRecord {
    if (!record) {
      throw new RecordNotFound();
    }
  }

  private verifyInternalOrigin(
    context: Partial<ChannelContext> | undefined
  ): asserts context is Partial<ChannelContext> {
    if (context?.origin !== INTERNAL_ORIGIN) {
      throw new OriginNotAllowed(context?.origin);
    }
  }

  async getCurrentAddress({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    return this.readCurrentAddress();
  }

  async uiGetWalletGroups({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    const groups = this.record?.walletManager.groups;
    return groups ? maskWalletGroups(groups) : null;
  }

  async uiGetWalletGroup({
    params: { groupId },
    context,
  }: PublicMethodParams<{ groupId: string }>) {
    this.verifyInternalOrigin(context);
    const group = this.record?.walletManager.groups.find(
      (group) => group.id === groupId
    );
    return group ? maskWalletGroup(group) : null;
  }

  async removeWalletGroup({
    params: { groupId },
    context,
  }: PublicMethodParams<{ groupId: string }>) {
    this.verifyInternalOrigin(context);
    if (!this.record) {
      throw new RecordNotFound();
    }
    this.record = Model.removeWalletGroup(this.record, { groupId });
    this.updateWalletStore(this.record);
  }

  async renameWalletGroup({
    params: { groupId, name },
    context,
  }: PublicMethodParams<{ groupId: string; name: string }>) {
    this.verifyInternalOrigin(context);
    if (!this.record) {
      throw new RecordNotFound();
    }
    this.record = Model.renameWalletGroup(this.record, { groupId, name });
    this.updateWalletStore(this.record);
  }

  async renameAddress({
    params: { address, name },
    context,
  }: PublicMethodParams<{ address: string; name: string }>) {
    this.verifyInternalOrigin(context);
    if (!this.record) {
      throw new RecordNotFound();
    }
    this.record = Model.renameAddress(this.record, { address, name });
    this.updateWalletStore(this.record);
  }

  async removeAddress({
    params: { address },
    context,
  }: PublicMethodParams<{ address: string }>) {
    this.verifyInternalOrigin(context);
    this.ensureRecord(this.record);
    this.record = Model.removeAddress(this.record, { address });
    this.updateWalletStore(this.record);
  }

  async updateLastBackedUp({
    params: { groupId },
    context,
  }: PublicMethodParams<{ groupId: string }>) {
    this.verifyInternalOrigin(context);
    this.ensureRecord(this.record);

    if (!groupId) {
      throw new Error('Must provide groupId');
    }
    this.record = Model.updateLastBackedUp(this.record, {
      groupId,
      timestamp: Date.now(),
    });
    this.updateWalletStore(this.record);
  }

  async getNoBackupCount({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    this.ensureRecord(this.record);
    return this.record.walletManager.groups
      .filter((group) => group.walletContainer.seedType === SeedType.mnemonic)
      .filter((group) => group.lastBackedUp == null).length;
  }

  async switchChain({ params: chain, context }: PublicMethodParams<string>) {
    this.verifyInternalOrigin(context);
    const networks = await networksStore.load();
    const chainId = networks.getChainId(createChain(chain));
    this.setChainId(chainId);
    this.emitter.emit('chainChanged', chainId);
  }

  getChainId() {
    return this.store.getState().chainId;
  }

  async requestChainId({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    return this.getChainId();
  }

  setChainId(chainId: string) {
    const value = ethers.utils.hexValue(chainId);
    this.store.setState({ chainId: value });
  }

  private async getProvider(chainId: string) {
    const networks = await networksStore.load();
    const nodeUrl = networks.getRpcUrlInternal(networks.getChainById(chainId));
    return new ethers.providers.JsonRpcProvider(nodeUrl);
  }

  private async getSigner(chainId: string) {
    const currentAddress = this.readCurrentAddress();
    if (!this.record) {
      throw new RecordNotFound();
    }
    const currentWallet = currentAddress
      ? Model.getWalletByAddress(this.record, currentAddress)
      : null;
    if (!currentWallet) {
      throw new Error('Wallet is not initialized');
    }

    const jsonRpcProvider = await this.getProvider(chainId);
    const wallet = toEthersWallet(currentWallet);
    return wallet.connect(jsonRpcProvider);
  }

  private async sendTransaction(
    incomingTransaction: IncomingTransaction,
    context: Partial<ChannelContext> | undefined
  ): Promise<ethers.providers.TransactionResponse> {
    this.verifyInternalOrigin(context);
    if (!incomingTransaction.from) {
      throw new Error(
        '"from" field is missing from the transaction object. Send from current address?'
      );
    }
    const currentAddress = this.ensureCurrentAddress();
    if (
      incomingTransaction.from.toLowerCase() !== currentAddress.toLowerCase()
    ) {
      throw new Error(
        // TODO?...
        'transaction "from" field is different from currently selected address'
      );
    }
    const { chainId } = this.store.getState();
    const targetChainId = incomingTransaction.chainId
      ? ethers.utils.hexValue(incomingTransaction.chainId)
      : null;
    if (targetChainId && chainId !== targetChainId) {
      throw new Error(
        'chainId in transaction object is different from current chainId'
      );
      // await this.wallet_switchEthereumChain({
      //   params: [{ chainId: targetChainId }],
      //   context,
      // });
      // return this.sendTransaction(incomingTransaction, context);
    } else if (targetChainId == null) {
      console.warn('chainId field is missing from transaction object');
      incomingTransaction.chainId = chainId;
    }
    const transaction = prepareTransaction(incomingTransaction);
    if (!hasGasPrice(transaction)) {
      await fetchAndAssignGasPrice(transaction);
    }

    const signer = await this.getSigner(chainId);
    const transactionResponse = await signer.sendTransaction({
      ...transaction,
      type: transaction.type || undefined,
    });
    const safeTx = removeSignature(transactionResponse);
    emitter.emit('pendingTransactionCreated', safeTx);
    return safeTx;
  }

  async signAndSendTransaction({
    params,
    context,
  }: PublicMethodParams<IncomingTransaction[]>) {
    this.verifyInternalOrigin(context);
    const transaction = params[0];
    if (!transaction) {
      throw new InvalidParams();
    }
    return this.sendTransaction(transaction, context);
  }

  async signTypedData_v4({
    params: { typedData: rawTypedData },
    context,
  }: PublicMethodParams<{ typedData: TypedData | string }>) {
    this.verifyInternalOrigin(context);
    if (!rawTypedData) {
      throw new InvalidParams();
    }
    const { chainId } = this.store.getState();
    const signer = await this.getSigner(chainId);
    const typedData = prepareTypedData(rawTypedData);
    const signature = await signer._signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );
    return signature;
  }

  async personalSign({
    params: [message],
    context,
  }: PublicMethodParams<[string, string?, string?]>) {
    this.verifyInternalOrigin(context);
    if (message == null) {
      throw new InvalidParams();
    }
    const { chainId } = this.store.getState();
    const signer = await this.getSigner(chainId);
    const messageAsUtf8String = toUtf8String(message);
    const signature = await signer.signMessage(messageAsUtf8String);
    return signature;
  }

  async getPendingTransactions({ context }: PublicMethodParams) {
    this.verifyInternalOrigin(context);
    return this.record?.transactions || [];
  }

  async logout() {
    chrome.storage.local.clear();
  }
}

class PublicController {
  wallet: Wallet;

  constructor(walletController: Wallet) {
    this.wallet = walletController;
  }

  async eth_accounts({ context }: PublicMethodParams) {
    const currentAddress = this.wallet.readCurrentAddress();
    if (!currentAddress) {
      return [];
    }
    if (this.wallet.allowedOrigin(context, currentAddress)) {
      return [currentAddress];
    } else {
      return [];
    }
  }

  async eth_requestAccounts({ context }: PublicMethodParams) {
    console.log('eth_requestAccounts');
    const currentAddress = this.wallet.readCurrentAddress();
    if (currentAddress && this.wallet.allowedOrigin(context, currentAddress)) {
      return [currentAddress];
    }
    if (!context?.origin) {
      throw new Error('This method requires origin');
    }
    // if (!this.wallet) {
    //   console.log('Must create wallet first');
    //   throw new Error('Must create wallet first');
    // }
    const { origin } = context;
    return new Promise((resolve, reject) => {
      notificationWindow.open({
        route: '/requestAccounts',
        search: `?origin=${origin}`,
        onResolve: async () => {
          const currentAddress = this.wallet.ensureCurrentAddress();
          this.wallet.acceptOrigin(origin, currentAddress);
          const accounts = await this.eth_accounts({ context });
          resolve(accounts);
        },
        onDismiss: () => {
          reject(new UserRejected('User Rejected the Request'));
        },
      });
    });
  }

  async eth_chainId({ context }: PublicMethodParams) {
    const currentAddress = this.wallet.readCurrentAddress();
    if (currentAddress && this.wallet.allowedOrigin(context, currentAddress)) {
      return this.wallet.getChainId();
    } else {
      return '0x1';
    }
  }

  async net_version({ context }: PublicMethodParams) {
    const currentAddress = this.wallet.readCurrentAddress();
    if (currentAddress && this.wallet.allowedOrigin(context, currentAddress)) {
      const chainId = this.wallet.getChainId();
      return String(parseInt(chainId));
    } else {
      return '1';
    }
  }

  async eth_sendTransaction({
    params,
    context,
  }: PublicMethodParams<UnsignedTransaction[]>) {
    const currentAddress = this.wallet.ensureCurrentAddress();
    // TODO: should we check transaction.from instead of currentAddress?
    if (!this.wallet.allowedOrigin(context, currentAddress)) {
      throw new OriginNotAllowed();
    }
    const transaction = params[0];
    if (!transaction) {
      throw new InvalidParams();
    }
    Object.assign(window, { transactionToSend: transaction });
    return new Promise((resolve, reject) => {
      notificationWindow.open({
        route: '/sendTransaction',
        search: `?${new URLSearchParams({
          origin: context.origin,
          transaction: JSON.stringify(transaction),
        })}`,
        onResolve: (hash) => {
          resolve(hash);
        },
        onDismiss: () => {
          reject(new UserRejectedTxSignature());
        },
      });
    });
  }

  async eth_signTypedData_v4({
    context,
    params: [address, data],
  }: PublicMethodParams<[string, TypedData | string]>) {
    const currentAddress = this.wallet.ensureCurrentAddress();
    if (!this.wallet.allowedOrigin(context, currentAddress)) {
      throw new OriginNotAllowed();
    }
    if (address.toLowerCase() !== currentAddress.toLowerCase()) {
      throw new Error(
        // TODO?...
        'Address parameter is different from currently selected address'
      );
    }
    const stringifiedData =
      typeof data === 'string' ? data : JSON.stringify(data);
    return new Promise((resolve, reject) => {
      notificationWindow.open({
        route: '/signMessage',
        search: `?${new URLSearchParams({
          origin: context.origin,
          typedData: stringifiedData,
          method: 'eth_signTypedData_v4',
        })}`,
        onResolve: (signature) => {
          resolve(signature);
        },
        onDismiss: () => {
          reject(new UserRejectedTxSignature());
        },
      });
    });
  }

  async eth_signTypedData({ context: _context }: PublicMethodParams) {
    throw new MethodNotImplemented('eth_signTypedData: Not Implemented');
  }

  async eth_sign({ context: _context }: PublicMethodParams) {
    throw new MethodNotImplemented('eth_sign: Not Implemented');
  }

  async personal_sign({
    params,
    context,
  }: PublicMethodParams<[string, string, string]>) {
    if (!params.length) {
      throw new InvalidParams();
    }
    const [message, address, _password] = params;
    const currentAddress = this.wallet.ensureCurrentAddress();
    if (address && address.toLowerCase() !== currentAddress.toLowerCase()) {
      throw new Error(
        // TODO?...
        'Address parameter is different from currently selected address'
      );
    }
    if (!this.wallet.allowedOrigin(context, currentAddress)) {
      throw new OriginNotAllowed();
    }
    return new Promise((resolve, reject) => {
      notificationWindow.open({
        route: '/signMessage',
        search: `?${new URLSearchParams({
          origin: context.origin,
          message,
          method: 'personal_sign',
        })}`,
        onResolve: (signature) => {
          resolve(signature);
        },
        onDismiss: () => {
          reject(new UserRejectedTxSignature());
        },
      });
    });
  }

  async wallet_switchEthereumChain({
    params,
    context,
  }: PublicMethodParams<[{ chainId: string | number }]>): Promise<
    null | object
  > {
    const currentAddress = this.wallet.readCurrentAddress();
    if (!currentAddress) {
      throw new Error('Wallet is not initialized');
    }
    if (!this.wallet.allowedOrigin(context, currentAddress)) {
      throw new OriginNotAllowed();
    }
    const { origin } = context;
    const { chainId: chainIdParameter } = params[0];
    const chainId = ethers.utils.hexValue(chainIdParameter);
    if (chainId === this.wallet.getChainId()) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      notificationWindow.open({
        route: '/switchEthereumChain',
        search: `?origin=${origin}&chainId=${chainId}`,
        onResolve: () => {
          this.wallet.setChainId(chainId);
          resolve(null);
          this.wallet.emitter.emit('chainChanged', chainId);
        },
        onDismiss: () => {
          reject(new UserRejected('User Rejected the Request'));
        },
      });
    });
  }
}
