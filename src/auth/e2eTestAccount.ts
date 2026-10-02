/**
 * In-memory stand-in for the account API, for the e2e identity seam only
 * (`e2eTestAuth.ts`): the account page can be driven without Clerk, with
 * synthetic data. Behaviour follows Clerk's: a new address needs a code
 * ("123456" here), a provider can be linked and unlinked.
 */

import type { AccountApi, AccountProfile, AvatarChoice } from './accountApi';

/** A 1x1 picture inline, so the e2e run never reaches for the network. */
const GOOGLE_PICTURE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';

export function createE2EAccountApi(fullName: string | null, email: string): AccountApi {
  const [first = '', ...rest] = (fullName ?? 'Anna Keller').split(' ');
  const state = {
    firstName: first,
    lastName: rest.join(' '),
    hasUploadedImage: false,
    prefersInitials: false,
    emails: [{ id: 'mail-1', address: email, verified: true, primary: true }],
    connections: [{ id: 'ext-1', provider: 'google', title: 'Google', identifier: email }],
    pendingId: 0,
  };
  const profile = (): AccountProfile => ({
    firstName: state.firstName,
    lastName: state.lastName,
    avatarUrl: null,
    hasUploadedImage: state.hasUploadedImage,
    prefersInitials: state.prefersInitials,
    providerImages: { google: GOOGLE_PICTURE },
    emails: state.emails.map((entry) => ({ ...entry })),
    connections: state.connections.map((entry) => ({ ...entry })),
    connectable: (['google', 'github'] as const).filter(
      (provider) => !state.connections.some((connection) => connection.provider === provider),
    ),
    passwordEnabled: false,
    twoFactorEnabled: false,
  });
  return {
    load: async () => profile(),
    updateName: async (firstName, lastName) => {
      state.firstName = firstName;
      state.lastName = lastName;
    },
    chooseAvatar: async (choice: AvatarChoice) => {
      state.prefersInitials = choice === 'initials';
      state.hasUploadedImage = choice !== 'initials';
    },
    uploadAvatar: async () => {
      state.hasUploadedImage = true;
      state.prefersInitials = false;
    },
    addEmail: async (address) => {
      state.pendingId += 1;
      const id = `mail-new-${state.pendingId}`;
      state.emails.push({ id, address, verified: false, primary: false });
      return id;
    },
    verifyEmail: async (id, code) => {
      if (code !== '123456') throw new Error('wrong-code');
      const entry = state.emails.find((candidate) => candidate.id === id);
      if (entry) entry.verified = true;
    },
    resendEmailCode: async () => undefined,
    removeEmail: async (id) => {
      state.emails = state.emails.filter((entry) => entry.id !== id);
    },
    makePrimaryEmail: async (id) => {
      for (const entry of state.emails) entry.primary = entry.id === id;
    },
    connect: async (provider) => {
      state.connections.push({ id: `ext-${provider}`, provider, title: provider === 'github' ? 'GitHub' : 'Google', identifier: email });
    },
    disconnect: async (id) => {
      state.connections = state.connections.filter((entry) => entry.id !== id);
    },
    mountSecurity: (node) => {
      node.textContent = 'Clerk: Passwort, Zwei-Faktor-Anmeldung';
      return () => {
        node.textContent = '';
      };
    },
    signOutOtherSessions: async () => 0,
  };
}
