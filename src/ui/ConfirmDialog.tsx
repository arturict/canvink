import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Styles the confirm button as destructive and focuses "Abbrechen" first. */
  danger?: boolean;
}

interface ConfirmDialogProps {
  request: ConfirmRequest;
  onResolve: (confirmed: boolean) => void;
}

/**
 * The app's replacement for `window.confirm`: a small modal alert dialog.
 * Escape and "Abbrechen" cancel, Tab stays between the two buttons, and
 * focus goes back to where it was when the dialog closes.
 */
export function ConfirmDialog({ request, onResolve }: ConfirmDialogProps) {
  const { t } = useI18n();
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (request.danger ? cancelRef : confirmRef).current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // The focus target is decided once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Keys never reach a parent dialog (a sync panel, the trash) behind this one.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onResolve(false);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      // Two buttons: Tab and Shift+Tab both move to the other one.
      const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current;
      next?.focus();
    }
  };

  return createPortal(
    <div
      className="confirm-overlay"
      role="presentation"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onResolve(false);
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`}>{request.title}</h2>
        <p id={`${id}-message`}>{request.message}</p>
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} type="button" onClick={() => onResolve(false)}>{t('common.cancel')}</button>
          <button
            ref={confirmRef}
            type="button"
            className={request.danger ? 'confirm-dialog__confirm confirm-dialog__confirm--danger' : 'confirm-dialog__confirm'}
            onClick={() => onResolve(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

interface PendingConfirm {
  request: ConfirmRequest;
  resolve: (confirmed: boolean) => void;
}

/**
 * `confirm(request)` resolves to the user's answer, so a call site reads
 * like `window.confirm` did: `if (!(await confirm({...}))) return;`.
 * Render `element` once anywhere in the component.
 */
export function useConfirm(): { confirm: (request: ConfirmRequest) => Promise<boolean>; element: ReactNode } {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => {
    pendingRef.current?.resolve(false);
    const next = { request, resolve };
    pendingRef.current = next;
    setPending(next);
  }), []);

  useEffect(() => () => {
    pendingRef.current?.resolve(false);
    pendingRef.current = null;
  }, []);

  return {
    confirm,
    element: pending ? <ConfirmDialog request={pending.request} onResolve={settle} /> : null,
  };
}
