/**
 * Which picture stands for an account, in one place. Everything that shows an
 * avatar (account menu, account page, presence for collaborators) reads the
 * result through `OptionalAuthUser.imageUrl`, so the order below holds
 * everywhere:
 *
 *   1. an image the user uploaded or picked (Clerk `hasImage`);
 *   2. otherwise the picture of the Google or GitHub account used most
 *      recently (Clerk copies it only at sign-up, so a provider linked
 *      later would otherwise never show);
 *   3. otherwise nothing, which renders initials.
 *
 * Choosing "Initialen" on the account page records `prefersInitials`, which
 * ends the order at step 1 so a provider picture does not come back.
 */

export type AvatarProvider = 'google' | 'github';

export interface AvatarExternalAccount {
  /** Clerk's provider slug, for example `google`. */
  provider: string;
  imageUrl?: string | null;
  /** Clerk lists unverified (half-linked) accounts too; those never lend a picture. */
  verified?: boolean;
}

export interface AvatarInputs {
  hasImage: boolean;
  imageUrl?: string | null;
  prefersInitials?: boolean;
  externalAccounts: readonly AvatarExternalAccount[];
  /** Clerk's `client.lastAuthenticationStrategy`, for example `oauth_github`. */
  lastStrategy?: string | null;
}

export interface ProviderAvatar {
  provider: AvatarProvider;
  url: string;
}

export function avatarProvider(value: string | null | undefined): AvatarProvider | null {
  const slug = value?.replace(/^oauth_/, '');
  return slug === 'google' || slug === 'github' ? slug : null;
}

/** Accounts that can lend a picture, oldest first (Clerk lists them in link order). */
function candidates(accounts: readonly AvatarExternalAccount[]): ProviderAvatar[] {
  const found: ProviderAvatar[] = [];
  for (const account of accounts) {
    const provider = avatarProvider(account.provider);
    if (!provider || account.verified === false || !account.imageUrl) continue;
    found.push({ provider, url: account.imageUrl });
  }
  return found;
}

/** The provider picture to use: the last strategy the user signed in with, else the most recently linked account. */
export function pickProviderAvatar(
  accounts: readonly AvatarExternalAccount[],
  lastStrategy?: string | null,
): ProviderAvatar | null {
  const list = candidates(accounts);
  const last = avatarProvider(lastStrategy);
  return list.find((entry) => entry.provider === last) ?? list.at(-1) ?? null;
}

/** The picture of one named provider, for the explicit "Profilbild: Google" choice. */
export function providerAvatar(accounts: readonly AvatarExternalAccount[], provider: AvatarProvider): string | null {
  return candidates(accounts).filter((entry) => entry.provider === provider).at(-1)?.url ?? null;
}

export function resolveAvatarUrl(input: AvatarInputs): string | null {
  if (input.hasImage && input.imageUrl) return input.imageUrl;
  if (input.prefersInitials) return null;
  return pickProviderAvatar(input.externalAccounts, input.lastStrategy)?.url ?? null;
}
