import { useState } from 'react';
import { presenceInitials, type PresenceUser } from '../../../collab/presence';
import './presence.css';

export function PresenceAvatar({ user, size = 28, away = false, className = '', stackIndex }: {
  user: Pick<PresenceUser, 'name' | 'color' | 'imageUrl'>;
  size?: number;
  away?: boolean;
  className?: string;
  /** In an overlapping stack the first face lies on top. */
  stackIndex?: number;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(user.imageUrl) && failedUrl !== user.imageUrl;
  return (
    <span
      className={`presence-avatar${away ? ' is-away' : ''}${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        ['--presence-color' as string]: user.color,
        fontSize: Math.round(size * 0.4),
        ...(stackIndex === undefined ? {} : { position: 'relative', zIndex: 10 - stackIndex }),
      }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={user.imageUrl}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          loading="lazy"
          draggable={false}
          onError={() => setFailedUrl(user.imageUrl ?? null)}
        />
      ) : presenceInitials(user.name)}
    </span>
  );
}
