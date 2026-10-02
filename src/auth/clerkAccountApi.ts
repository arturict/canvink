import type { useClerk, useUser } from '@clerk/clerk-react';
import type { AccountApi, AccountConnection, AccountProfile, AvatarChoice } from './accountApi';
import { avatarProvider, providerAvatar, resolveAvatarUrl, type AvatarProvider } from './avatar';
import { clerkProfileAppearance } from './clerkAppearance';
import { safeAvatarUrl } from '../collab/presence';

type Clerk = ReturnType<typeof useClerk>;
export type ClerkUser = NonNullable<ReturnType<typeof useUser>['user']>;

const CONNECTABLE: readonly AvatarProvider[] = ['google', 'github'];
/** Marks that the user picked "Initialen", so a provider picture does not come back (`unsafeMetadata`, readable by the user only). */
const INITIALS_KEY = 'canvinkAvatar';

/** The pieces `resolveAvatarUrl` reads, taken from a Clerk user. */
export function avatarInputsOf(user: ClerkUser, lastStrategy: string | null | undefined) {
  return {
    hasImage: user.hasImage,
    imageUrl: user.imageUrl,
    prefersInitials: user.unsafeMetadata?.[INITIALS_KEY] === 'initials',
    externalAccounts: user.externalAccounts.map((account) => ({
      provider: account.provider,
      imageUrl: safeAvatarUrl(account.imageUrl) ?? null,
      verified: account.verification?.status === 'verified',
    })),
    lastStrategy,
  };
}

export function resolvedAvatarOf(user: ClerkUser, clerk: Clerk): string | null {
  return resolveAvatarUrl(avatarInputsOf(user, clerk.client?.lastAuthenticationStrategy));
}

/** Clerk's image upload takes a file; a provider picture is fetched first so it becomes the account's own image. */
async function fetchImage(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('avatar-fetch-failed');
  return response.blob();
}

export async function setProviderAvatar(user: ClerkUser, url: string): Promise<void> {
  await user.setProfileImage({ file: await fetchImage(url) });
  if (user.unsafeMetadata?.[INITIALS_KEY]) {
    await user.update({ unsafeMetadata: { ...user.unsafeMetadata, [INITIALS_KEY]: null } });
  }
}

export function createClerkAccountApi(clerk: Clerk): AccountApi {
  const requireUser = (): ClerkUser => {
    if (!clerk.user) throw new Error('not-signed-in');
    return clerk.user;
  };

  const clearInitials = async (user: ClerkUser) => {
    if (user.unsafeMetadata?.[INITIALS_KEY]) {
      await user.update({ unsafeMetadata: { ...user.unsafeMetadata, [INITIALS_KEY]: null } });
    }
  };

  return {
    async load(): Promise<AccountProfile> {
      const user = requireUser();
      await user.reload();
      const accounts = avatarInputsOf(user, clerk.client?.lastAuthenticationStrategy).externalAccounts;
      const providerImages: AccountProfile['providerImages'] = {};
      for (const provider of CONNECTABLE) {
        const url = providerAvatar(accounts, provider);
        if (url) providerImages[provider] = url;
      }
      const connections: AccountConnection[] = user.externalAccounts.map((account) => ({
        id: account.id,
        provider: avatarProvider(account.provider) ?? account.provider,
        title: account.providerTitle(),
        identifier: account.username || account.emailAddress || '',
      }));
      const linked = new Set(connections.map((connection) => connection.provider));
      return {
        firstName: user.firstName ?? '',
        lastName: user.lastName ?? '',
        avatarUrl: safeAvatarUrl(resolvedAvatarOf(user, clerk) ?? undefined) ?? null,
        hasUploadedImage: user.hasImage,
        prefersInitials: user.unsafeMetadata?.[INITIALS_KEY] === 'initials',
        providerImages,
        emails: user.emailAddresses.map((email) => ({
          id: email.id,
          address: email.emailAddress,
          verified: email.verification.status === 'verified',
          primary: email.id === user.primaryEmailAddressId,
        })),
        connections,
        connectable: CONNECTABLE.filter((provider) => !linked.has(provider)),
        passwordEnabled: user.passwordEnabled,
        twoFactorEnabled: user.twoFactorEnabled,
      };
    },
    async updateName(firstName, lastName) {
      await requireUser().update({ firstName, lastName });
    },
    async chooseAvatar(choice: AvatarChoice) {
      const user = requireUser();
      if (choice === 'initials') {
        await user.setProfileImage({ file: null });
        await user.update({ unsafeMetadata: { ...user.unsafeMetadata, [INITIALS_KEY]: 'initials' } });
        return;
      }
      const url = providerAvatar(avatarInputsOf(user, null).externalAccounts, choice);
      if (!url) throw new Error('no-provider-image');
      await setProviderAvatar(user, url);
    },
    async uploadAvatar(file) {
      const user = requireUser();
      await user.setProfileImage({ file });
      await clearInitials(user);
    },
    async addEmail(address) {
      const email = await requireUser().createEmailAddress({ email: address });
      await email.prepareVerification({ strategy: 'email_code' });
      return email.id;
    },
    async verifyEmail(id, code) {
      const email = requireUser().emailAddresses.find((entry) => entry.id === id);
      if (!email) throw new Error('unknown-email');
      await email.attemptVerification({ code });
    },
    async resendEmailCode(id) {
      const email = requireUser().emailAddresses.find((entry) => entry.id === id);
      if (!email) throw new Error('unknown-email');
      await email.prepareVerification({ strategy: 'email_code' });
    },
    async removeEmail(id) {
      await requireUser().emailAddresses.find((entry) => entry.id === id)?.destroy();
    },
    async makePrimaryEmail(id) {
      await requireUser().update({ primaryEmailAddressId: id });
    },
    async connect(provider) {
      const account = await requireUser().createExternalAccount({
        strategy: `oauth_${provider}`,
        redirectUrl: window.location.href,
      });
      const target = account.verification?.externalVerificationRedirectURL;
      if (target) window.location.assign(target.toString());
    },
    async disconnect(id) {
      await requireUser().externalAccounts.find((account) => account.id === id)?.destroy();
    },
    mountSecurity(node) {
      clerk.mountUserProfile(node, {
        routing: 'virtual',
        __experimental_startPath: '/security',
        appearance: clerkProfileAppearance,
      });
      return () => clerk.unmountUserProfile(node);
    },
    async signOutOtherSessions() {
      const user = requireUser();
      const sessions = await user.getSessions();
      const others = sessions.filter((session) => session.id !== clerk.session?.id);
      await Promise.all(others.map((session) => session.revoke()));
      return others.length;
    },
  };
}
