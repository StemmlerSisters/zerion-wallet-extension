import React from 'react';
import type { WalletGroup } from 'src/shared/types/WalletGroup';
import { WalletOrigin } from 'src/shared/WalletOrigin';
import { HStack } from 'src/ui/ui-kit/HStack';
import { UIText } from 'src/ui/ui-kit/UIText';
import WarningIcon from 'jsx:src/ui/assets/warning-icon-trimmed.svg';
import {
  isHardwareContainer,
  isMnemonicContainer,
} from 'src/shared/types/validators';

export function needsBackup(group: WalletGroup) {
  return (
    isMnemonicContainer(group.walletContainer) &&
    group.origin === WalletOrigin.extension &&
    group.lastBackedUp == null
  );
}

export function BackupInfoNote({ group }: { group: WalletGroup }) {
  const isHardwareGroup = isHardwareContainer(group.walletContainer);
  return group.lastBackedUp != null ? (
    <UIText kind="caption/regular" color="var(--neutral-500)">
      Last Backup:{' '}
      {new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
      }).format(group.lastBackedUp)}
    </UIText>
  ) : group.origin === WalletOrigin.extension ? (
    <HStack gap={4} alignItems="center" style={{ color: 'var(--notice-500)' }}>
      <WarningIcon style={{ width: 16, height: 16 }} />
      <UIText kind="caption/regular">Never backed up</UIText>
    </HStack>
  ) : group.origin === WalletOrigin.imported ? (
    <UIText kind="caption/regular" color="var(--neutral-500)">
      {isHardwareGroup ? 'Connected' : 'Imported'} on{' '}
      {new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(group.created)}
    </UIText>
  ) : null;
}
