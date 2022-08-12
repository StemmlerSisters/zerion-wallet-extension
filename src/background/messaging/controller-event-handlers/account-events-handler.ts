import { Wallet } from 'src/shared/types/Wallet';
import type { Account } from 'src/background/account/Account';
import { emitter } from 'src/background/events';

export function handleAccountEvents({ account }: { account: Account }) {
  const disposers: Array<() => void> = [];
  const removeListeners = () => {
    disposers.forEach((cb) => cb());
    disposers.length = 0;
  };

  function addWalletEventListeners(wallet: Wallet) {
    disposers.push(
      wallet.emitter.on('recordUpdated', () => {
        console.log('recordUpdated, emitting accountsChanged');
        emitter.emit('accountsChanged');
      }),
      wallet.emitter.on('currentAddressChange', () => {
        emitter.emit('accountsChanged');
      }),
      wallet.emitter.on('permissionsUpdated', () => {
        emitter.emit('accountsChanged');
      }),
      wallet.emitter.on('chainChanged', (chainId: string) => {
        emitter.emit('chainChanged', chainId);
      })
    );
  }

  addWalletEventListeners(account.getCurrentWallet());

  account.on('authenticated', async () => {
    console.log('authenticated, emitting accountsChanged');
    emitter.emit('accountsChanged');
    const chainId = await account.getCurrentWallet().getChainId();
    emitter.emit('chainChanged', chainId);
  });

  account.on('reset', () => {
    removeListeners();
    addWalletEventListeners(account.getCurrentWallet());
    emitter.emit('accountsChanged');
  });
}
