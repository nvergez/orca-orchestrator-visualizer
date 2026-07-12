import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Is this database on a network filesystem?
 *
 * SQLite is explicit: *"All processes using a database must be on the same host computer;
 * WAL does not work over a network filesystem."* Reading Orca's database across NFS, SMB,
 * 9p, `/mnt/c` from WSL, or an sshfs mount of a remote `orca serve` host does not fail
 * loudly — it fails *quietly*, with a reader that sees a torn view of the WAL. So it is a
 * startup error, by design (SPEC §2.3).
 */

const NETWORK_FILESYSTEMS = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smbfs',
  'smb3',
  '9p', // WSL 2's /mnt/c, and Plan 9 shares generally.
  'drvfs', // WSL 1's Windows drive mount.
  'sshfs',
  'fuse.sshfs',
  'fuse.rclone',
  'davfs',
  'fuse.davfs',
  'afs',
  'ceph',
  'glusterfs',
  'lustre',
  'ncpfs',
  'coda',
]);

/** The kernel's mount table. Injected in tests; absent on anything without procfs. */
export type ReadMounts = () => string | null;

export function readMountTable(): string | null {
  try {
    return readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null; // Not Linux, or a kernel without procfs.
  }
}

/**
 * The filesystem type the path sits on, when it is a network one and the platform can tell
 * us; null otherwise.
 *
 * Linux — which is also WSL, and so covers `/mnt/c` — is answered exactly, from the
 * kernel's own mount table. Windows answers the case it can see without shelling out: a
 * UNC path.
 *
 * **macOS is a known gap.** Telling an NFS mount from a local one there needs `statfs`'s
 * `f_fstypename`, which Node does not expose — `fs.statfsSync().type` is an undocumented
 * legacy number on Darwin — and the alternative is spawning `mount(8)` on every boot. A
 * false positive here would be a hard startup error refusing a database that works, which
 * is worse than the gap. Every case the ticket enumerates (NFS/SMB/9p, `/mnt/c` from WSL,
 * sshfs) is a Linux mount and is caught here.
 */
export function networkFilesystem(
  dbPath: string,
  { platform, readMounts }: { platform: NodeJS.Platform; readMounts: ReadMounts }
): string | null {
  if (platform === 'win32') {
    return dbPath.startsWith('\\\\') || dbPath.startsWith('//') ? 'a UNC network share' : null;
  }

  const table = readMounts();
  if (!table) return null;

  const target = resolve(dbPath);
  let deepest: { point: string; type: string } | null = null;

  for (const line of table.split('\n')) {
    // `/proc/mounts`: device, mount point, fs type, options… A space inside a mount point
    // is written as the octal escape `\040`.
    const [, point, type] = line.split(' ');
    if (!point || !type) continue;

    const mountPoint = point.replace(/\\040/g, ' ');
    const prefix = mountPoint.endsWith(sep) ? mountPoint : mountPoint + sep;
    if (target !== mountPoint && !target.startsWith(prefix)) continue;

    // The *nearest enclosing* mount owns the file. `/` matches everything, so the longest
    // matching mount point is the one actually holding the database.
    if (!deepest || mountPoint.length > deepest.point.length) deepest = { point: mountPoint, type };
  }

  return deepest && NETWORK_FILESYSTEMS.has(deepest.type) ? deepest.type : null;
}
