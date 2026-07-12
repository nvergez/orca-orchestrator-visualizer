import { useId } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/**
 * "Show heartbeats" — the one control the heartbeat ruling needs, wherever messages are shown.
 *
 * **Heartbeats are 65% of all traffic** (302 of 466 live) and every one of them carries a
 * `taskId`. Rendered straight, a list of messages is a heartbeat ticker with the real events lost
 * inside it — so they are hidden by default and one click away, in the feed (SPEC §7.7) and in
 * the inspector alike, where a single dispatched task can otherwise be five beats and one
 * `worker_done`.
 *
 * One component, because it is one *ruling*: the rule lives in `select.ts`, and the control that
 * turns it off has to say the same thing in both panels — including how many rows it is holding
 * back, which is the difference between "the tool lost my messages" and "the tool is hiding the
 * boring ones and told me so".
 */
export type HeartbeatToggleProps = {
  showHeartbeats: boolean;
  onChange: (showHeartbeats: boolean) => void;
  /** How many rows in scope are being held back. 0 ⇒ nothing to explain. */
  hidden: number;
};

export function HeartbeatToggle({ showHeartbeats, onChange, hidden }: HeartbeatToggleProps) {
  // Both panels can be mounted in one page in a test, and a duplicated `id` would hand the
  // wrong box to the wrong label.
  const id = useId();

  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={showHeartbeats}
        onCheckedChange={(checked) => onChange(checked === true)}
        className="size-3.5"
      />
      <Label htmlFor={id} className="text-muted-foreground cursor-pointer gap-1.5 text-xs font-normal">
        Show heartbeats
        {hidden > 0 && (
          <span className="text-muted-foreground/70">
            · {hidden} {hidden === 1 ? 'heartbeat' : 'heartbeats'} hidden
          </span>
        )}
      </Label>
    </div>
  );
}
