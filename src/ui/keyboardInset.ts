/**
 * Keeps the page usable while the Windows touch keyboard (or any on-screen
 * keyboard) is open. The keyboard height is published as `--keyboard-inset`
 * on the root element; the shell subtracts it from its height, so toolbars
 * stay above the keyboard, and the focused text field is scrolled (or, on the
 * canvas, the page is panned) until its caret is visible.
 *
 * Source of the height, best first: the VirtualKeyboard API with
 * `overlaysContent` (Chromium, WebView2), else the difference between the
 * layout and the visual viewport.
 */

interface VirtualKeyboardLike extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: { readonly height: number };
}

interface ViewportLike extends EventTarget {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
}

/** Below this the visual viewport only changed for browser chrome, not a keyboard. */
const MIN_KEYBOARD_HEIGHT = 80;
/** Space kept between the caret and the keyboard. */
const CARET_MARGIN = 16;

export function viewportKeyboardInset(layoutHeight: number, viewport: Pick<ViewportLike, 'height' | 'offsetTop' | 'scale'>): number {
  // A pinched-in visual viewport is smaller too, but no keyboard is involved.
  if (viewport.scale > 1.01) return 0;
  const inset = Math.round(layoutHeight - viewport.height - viewport.offsetTop);
  return inset >= MIN_KEYBOARD_HEIGHT ? inset : 0;
}

/** How far a caret box reaches below the space above the keyboard; 0 when it fits. */
export function caretOverflow(caretBottom: number, visibleBottom: number, margin = CARET_MARGIN): number {
  return Math.max(0, Math.ceil(caretBottom + margin - visibleBottom));
}

export type CaretRevealHandler = (target: Element, overflow: number) => boolean;
const revealHandlers = new Set<CaretRevealHandler>();

/**
 * Lets a pannable surface (the canvas) move itself instead of the browser
 * scrolling it. The handler returns true when it took over.
 */
export function subscribeCaretReveal(handler: CaretRevealHandler): () => void {
  revealHandlers.add(handler);
  return () => revealHandlers.delete(handler);
}

function navigatorKeyboard(): VirtualKeyboardLike | null {
  const candidate: unknown = typeof navigator === 'undefined' ? null : Reflect.get(navigator, 'virtualKeyboard');
  return candidate instanceof EventTarget
    && 'overlaysContent' in candidate
    && 'boundingRect' in candidate
    ? candidate as VirtualKeyboardLike
    : null;
}

function isEditable(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(element.type);
  }
  return element.isContentEditable;
}

function caretBottom(element: HTMLElement): number {
  const selection = window.getSelection();
  if (element.isContentEditable && selection && selection.rangeCount > 0 && selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (rect.height > 0 && element.contains(range.startContainer)) return rect.bottom;
  }
  return element.getBoundingClientRect().bottom;
}

let currentInset = 0;

function visibleBottom(): number {
  const viewport: ViewportLike | undefined = window.visualViewport ?? undefined;
  const visualBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  return Math.min(visualBottom, window.innerHeight - currentInset);
}

/** Brings the focused text field's caret above the keyboard. */
export function revealFocusedCaret(): void {
  const active = document.activeElement;
  if (!isEditable(active)) return;
  const overflow = caretOverflow(caretBottom(active), visibleBottom());
  if (overflow === 0) return;
  for (const handler of revealHandlers) {
    if (handler(active, overflow)) return;
  }
  active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setInset(next: number): void {
  if (next === currentInset) return;
  currentInset = next;
  document.documentElement.style.setProperty('--keyboard-inset', `${next}px`);
  document.documentElement.dataset.keyboard = next > 0 ? 'open' : 'closed';
  // The shell resizes in the same frame; measure after it has.
  requestAnimationFrame(revealFocusedCaret);
}

/**
 * `overlay: false` leaves the keyboard to shorten the window, as the phone
 * app's activity does (MainActivity pads the WebView by the keyboard); only
 * the caret is kept in view then.
 */
export function installKeyboardInset(options: { overlay?: boolean } = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const cleanups: Array<() => void> = [];
  const keyboard = options.overlay === false ? null : navigatorKeyboard();
  const viewport: ViewportLike | undefined = window.visualViewport ?? undefined;

  if (keyboard) {
    keyboard.overlaysContent = true;
    const onGeometry = () => setInset(Math.round(keyboard.boundingRect.height));
    keyboard.addEventListener('geometrychange', onGeometry);
    cleanups.push(() => keyboard.removeEventListener('geometrychange', onGeometry));
  } else if (viewport) {
    const onResize = () => setInset(viewportKeyboardInset(window.innerHeight, viewport));
    viewport.addEventListener('resize', onResize);
    viewport.addEventListener('scroll', onResize);
    cleanups.push(() => {
      viewport.removeEventListener('resize', onResize);
      viewport.removeEventListener('scroll', onResize);
    });
  }

  const onFocusIn = () => {
    // The keyboard opens a moment after the field is focused; the inset change
    // reveals the caret then, this covers a keyboard that is already open.
    requestAnimationFrame(revealFocusedCaret);
  };
  // An orientation change or window resize moves the fields; keep the caret in view.
  const onResize = () => requestAnimationFrame(revealFocusedCaret);
  document.addEventListener('focusin', onFocusIn);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  cleanups.push(() => {
    document.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
  });
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
