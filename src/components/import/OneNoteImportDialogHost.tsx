import { createTauriSystemBrowserCallbackBridge, isTauriSystemBrowserAvailable } from '../../import/graph';
import OneNoteImportDialog, { type OneNoteImportDialogProps } from './OneNoteImportDialog';

/**
 * The OneNote import dialog with the desktop app's system-browser sign-in wired
 * in. The notebook shell loads this module on demand: the Microsoft sign-in
 * library behind it is a sizeable part of the app that opening a notebook never
 * needs.
 */
export default function OneNoteImportDialogHost(props: Omit<OneNoteImportDialogProps, 'systemBrowserFactory'>) {
  return (
    <OneNoteImportDialog
      {...props}
      systemBrowserFactory={isTauriSystemBrowserAvailable() ? createTauriSystemBrowserCallbackBridge : undefined}
    />
  );
}
