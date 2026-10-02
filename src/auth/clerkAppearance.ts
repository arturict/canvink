/**
 * Clerk's modals in Canvink's own look: the app's green as the primary
 * colour, its radius and the system font instead of Clerk's defaults.
 * Typed structurally so this module needs no Clerk import (it is bundled
 * with the lazily loaded Clerk chunk either way).
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: '#3f6859',
    colorText: '#1e2925',
    colorTextSecondary: '#5f6964',
    colorBackground: '#fffefa',
    colorInputBackground: '#ffffff',
    borderRadius: '10px',
    fontFamily: 'inherit',
  },
  layout: {
    socialButtonsPlacement: 'top' as const,
    // Full-width "Mit Google anmelden" / "Mit GitHub anmelden" instead of two compact buttons.
    socialButtonsVariant: 'blockButton' as const,
  },
};

/**
 * Clerk's password and two-step pages inside the account page: no card chrome,
 * navigation or shadow of their own, since the page already supplies the
 * frame, and the app's tokens for text and buttons.
 */
export const clerkProfileAppearance = {
  ...clerkAppearance,
  variables: { ...clerkAppearance.variables, fontSize: '14px' },
  elements: {
    rootBox: { width: '100%' },
    cardBox: {
      width: '100%',
      maxWidth: '100%',
      height: 'auto',
      boxShadow: 'none',
      border: 'none',
      borderRadius: 0,
      background: 'transparent',
    },
    card: { boxShadow: 'none', background: 'transparent' },
    navbar: { display: 'none' },
    navbarMobileMenuRow: { display: 'none' },
    scrollBox: { borderRadius: 0, background: 'transparent' },
    pageScrollBox: { padding: 0 },
    footer: { display: 'none' },
  },
};
