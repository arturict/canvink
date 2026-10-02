/**
 * What the account page needs from the sign-in provider, Clerk-agnostic like
 * the rest of `AuthContext`: `ClerkAuthBridge` implements it with Clerk's user
 * object, the e2e identity seam with an in-memory fake. The page itself never
 * imports Clerk, so it stays out of the startup chunk.
 */

import type { AvatarProvider } from './avatar';

export interface AccountEmail {
  id: string;
  address: string;
  verified: boolean;
  primary: boolean;
}

export interface AccountConnection {
  id: string;
  provider: AvatarProvider | string;
  /** "Google", "GitHub": the provider's own name. */
  title: string;
  /** The e-mail address or username the provider reported. */
  identifier: string;
}

export type AvatarChoice = AvatarProvider | 'initials';

export interface AccountProfile {
  firstName: string;
  lastName: string;
  /** The picture in use after the fallback order of `resolveAvatarUrl`. */
  avatarUrl: string | null;
  hasUploadedImage: boolean;
  /** The user chose "Initialen": no provider picture comes back. */
  prefersInitials: boolean;
  /** Pictures the linked providers offer, for the "Profilbild" choice. */
  providerImages: Partial<Record<AvatarProvider, string>>;
  emails: AccountEmail[];
  connections: AccountConnection[];
  /** Providers that can still be linked. */
  connectable: AvatarProvider[];
  passwordEnabled: boolean;
  twoFactorEnabled: boolean;
}

export interface AccountApi {
  load(): Promise<AccountProfile>;
  updateName(firstName: string, lastName: string): Promise<void>;
  /** Uses one provider's picture, or removes the picture for initials. */
  chooseAvatar(choice: AvatarChoice): Promise<void>;
  uploadAvatar(file: File): Promise<void>;
  /** Adds an address and sends a code to it; returns the new address id. */
  addEmail(address: string): Promise<string>;
  verifyEmail(id: string, code: string): Promise<void>;
  resendEmailCode(id: string): Promise<void>;
  removeEmail(id: string): Promise<void>;
  makePrimaryEmail(id: string): Promise<void>;
  /** Leaves the page for the provider's consent screen and returns to this URL. */
  connect(provider: AvatarProvider): Promise<void>;
  disconnect(id: string): Promise<void>;
  /** Clerk's own password and two-step flows, styled like the app. Returns the unmount function. */
  mountSecurity(node: HTMLDivElement): () => void;
  /** Ends every browser session except this one; returns how many. */
  signOutOtherSessions(): Promise<number>;
}
