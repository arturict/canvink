import { useEffect, useState } from 'react';
import { retryableLazy } from '../retryableLazy';
import type { DocHandleChangePayload } from '@automerge/automerge-repo';
import type { LivePageDocV2 } from '../../crdt';
import { enumerateAutomergeConflicts } from './conflicts';
import { SYNC_CONFIGURATION_KEY } from './configurationKey';
import type { SyncCollaborationPanelProps } from './SyncCollaborationPanel';

// The panel pulls in the whole encrypted sync client (libsodium, Appwrite),
// about a third of what the notebook shell loads at start.
const SyncCollaborationPanel = retryableLazy(() => import('./SyncCollaborationPanel'));

function hasSavedConfiguration(): boolean {
  try {
    return Boolean(window.localStorage.getItem(SYNC_CONFIGURATION_KEY));
  } catch {
    return false;
  }
}

/**
 * Mounts the team sync panel once there is something for it to show: a saved
 * sync configuration, or a conflict in the open page (its badge is what opens
 * the panel). Until then it costs nothing, and the sync client is never
 * loaded. Once mounted the panel stays, like before.
 */
export default function TeamSyncHost(props: SyncCollaborationPanelProps) {
  const { pageHandle } = props;
  const [needed, setNeeded] = useState(
    () => hasSavedConfiguration() || enumerateAutomergeConflicts(pageHandle.doc()).length > 0,
  );

  useEffect(() => {
    if (needed) return;
    const check = ({ doc, patchInfo }: DocHandleChangePayload<LivePageDocV2>) => {
      // A local edit cannot create a conflict; scanning walks every point of
      // every stroke, so only changes from elsewhere are worth it.
      if (patchInfo.source !== 'change' && enumerateAutomergeConflicts(doc).length > 0) setNeeded(true);
    };
    pageHandle.on('change', check);
    return () => { pageHandle.off('change', check); };
  }, [needed, pageHandle]);

  if (!needed) return null;
  return <SyncCollaborationPanel {...props} />;
}
