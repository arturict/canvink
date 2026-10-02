import { describe, expect, it } from 'vitest';
import { avatarProvider, pickProviderAvatar, providerAvatar, resolveAvatarUrl } from './avatar';

const GOOGLE = 'https://img.clerk.com/google-photo';
const GITHUB = 'https://img.clerk.com/github-photo';
const UPLOAD = 'https://img.clerk.com/uploaded';

const accounts = [
  { provider: 'google', imageUrl: GOOGLE },
  { provider: 'github', imageUrl: GITHUB },
];

describe('avatar fallback order', () => {
  it('prefers an uploaded or chosen image over any provider picture', () => {
    expect(resolveAvatarUrl({ hasImage: true, imageUrl: UPLOAD, externalAccounts: accounts })).toBe(UPLOAD);
  });

  it('falls back to the provider used most recently', () => {
    expect(resolveAvatarUrl({ hasImage: false, imageUrl: 'https://img.clerk.com/generated', externalAccounts: accounts, lastStrategy: 'oauth_google' })).toBe(GOOGLE);
    expect(resolveAvatarUrl({ hasImage: false, externalAccounts: accounts, lastStrategy: 'oauth_github' })).toBe(GITHUB);
  });

  it('takes the most recently linked account when the last strategy is unknown or has no picture', () => {
    expect(resolveAvatarUrl({ hasImage: false, externalAccounts: accounts })).toBe(GITHUB);
    expect(
      resolveAvatarUrl({
        hasImage: false,
        externalAccounts: [{ provider: 'google', imageUrl: GOOGLE }, { provider: 'github', imageUrl: '' }],
        lastStrategy: 'oauth_github',
      }),
    ).toBe(GOOGLE);
  });

  it('never uses the generated placeholder, an unverified account or an unsupported provider', () => {
    expect(
      resolveAvatarUrl({
        hasImage: false,
        imageUrl: 'https://img.clerk.com/generated',
        externalAccounts: [
          { provider: 'google', imageUrl: GOOGLE, verified: false },
          { provider: 'facebook', imageUrl: 'https://img.clerk.com/fb' },
        ],
      }),
    ).toBeNull();
  });

  it('shows initials when the user chose them, and when there is nothing to show', () => {
    expect(resolveAvatarUrl({ hasImage: false, prefersInitials: true, externalAccounts: accounts })).toBeNull();
    expect(resolveAvatarUrl({ hasImage: false, externalAccounts: [] })).toBeNull();
  });

  it('reads a provider slug from Clerk strategies and providers', () => {
    expect(avatarProvider('oauth_google')).toBe('google');
    expect(avatarProvider('github')).toBe('github');
    expect(avatarProvider('oauth_apple')).toBeNull();
    expect(avatarProvider(null)).toBeNull();
  });

  it('picks one named provider for the explicit choice', () => {
    expect(providerAvatar(accounts, 'github')).toBe(GITHUB);
    expect(providerAvatar([{ provider: 'google', imageUrl: GOOGLE }], 'github')).toBeNull();
    expect(pickProviderAvatar(accounts, 'oauth_google')).toEqual({ provider: 'google', url: GOOGLE });
  });
});
