import { dnaServicePort } from 'src/ui/shared/channels';

export function initDnaApi() {
  // dnaServicePort.request('developerOnly_resetActionQueue');
  dnaServicePort.request('tryRegisterAction');
}

export async function updateAddressDnaInfo(address: string) {
  await dnaServicePort.request('gm', { address });
}
