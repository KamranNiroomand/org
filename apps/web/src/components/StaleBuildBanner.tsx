import { useQuery } from '@tanstack/react-query';
import { api, type Health } from '../lib/api';

/**
 * Says out loud when the running server is older than the code on disk.
 *
 * The failure this answers: three merged bug fixes sat un-deployed for a
 * week because the server process had been up since before the first of
 * them landed. Nothing said so. The auto-entry job, running week-old code,
 * then opened a $122,440 position on a $100,000 account — the exact bug one
 * of those fixes had corrected. Every review had passed; "merged" and
 * "running" were simply different facts, and only one was visible.
 *
 * Deliberately not dismissible. A banner you can dismiss is one you dismiss
 * on the busy day and then never see again, which is precisely the day it
 * matters. It disappears on its own the moment the server is restarted,
 * which is also the only thing that fixes it.
 */
export function StaleBuildBanner() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/api/health'),
    // Overrides the shared `staleTime: Infinity` this key carries in
    // settings.tsx: that is fine for a currency code, but the whole point
    // here is to notice a merge that happened while the tab stayed open.
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const build = data?.build;
  if (!build?.drifted) return null;

  const booted = build.bootSha?.slice(0, 8) ?? 'unknown';
  const head = build.headSha?.slice(0, 8) ?? 'unknown';

  return (
    <div
      role="status"
      // Sticky, not merely first: `<main>` is the scroll container, so a
      // banner that only sits at the top scrolls away on any long page —
      // achieving with no click what the non-dismissible choice above was
      // meant to prevent, and on exactly the deep list views where a stale
      // server is most likely to matter.
      className="sticky top-0 z-10 border-b border-warning/40 bg-warning/10 px-6 py-2.5 text-[13px] leading-relaxed backdrop-blur"
    >
      <span className="font-medium">This server is running older code than your checkout.</span>{' '}
      Booted at <code className="tnum">{booted}</code>, but{' '}
      <code className="tnum">{build.branch ?? 'the working tree'}</code> is now at{' '}
      <code className="tnum">{head}</code>. Anything merged since then — including scheduled jobs
      like auto-entry and the exit engine — is still running the old code. Restart the server to
      pick it up.
    </div>
  );
}
