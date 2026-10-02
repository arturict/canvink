import { useCallback, useEffect, useState } from 'react';
import type { AccountApi, AccountProfile, OptionalAuthValue } from '../../auth';
import type { ConfirmRequest } from '../../ui/ConfirmDialog';

export type SignedInAuth = Extract<OptionalAuthValue, { available: true }>;
export type Confirm = (request: ConfirmRequest) => Promise<boolean>;

export type ProfileState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; profile: AccountProfile };

/** Loads the account profile and reloads it after every change the page makes. */
export function useAccountProfile(account: AccountApi | undefined): { state: ProfileState; reload(): Promise<void> } {
  const [state, setState] = useState<ProfileState>({ status: 'loading' });
  const reload = useCallback(async () => {
    if (!account) return;
    try {
      setState({ status: 'ready', profile: await account.load() });
    } catch {
      setState((current) => (current.status === 'ready' ? current : { status: 'failed' }));
    }
  }, [account]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profile = await account?.load();
        if (!cancelled && profile) setState({ status: 'ready', profile });
      } catch {
        if (!cancelled) setState({ status: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);
  return { state, reload };
}
