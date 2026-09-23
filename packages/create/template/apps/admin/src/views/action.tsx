import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { adminAction } from "../api";

/** A platform action: the operator must give a reason, which is audited with the correlation ID. */
export function ActionButton({ label, path, invalidate, allowed }: { label: string; path: string; invalidate: string; allowed: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const action = useMutation({
    mutationFn: () => adminAction<{ correlationId: string }>(path, reason),
    onSuccess: async () => { setOpen(false); setReason(""); await client.invalidateQueries({ queryKey: [invalidate] }); },
  });
  if (!allowed) return null;
  if (!open) return <button type="button" className="text-sm text-primary underline" onClick={() => setOpen(true)}>{label}</button>;
  const submit = (event: FormEvent) => { event.preventDefault(); action.mutate(); };
  return <form className="flex items-center gap-2" onSubmit={submit}>
    <label className="sr-only" htmlFor={`${path}-reason`}>Reason</label>
    <input id={`${path}-reason`} required maxLength={500} placeholder="Reason (audited)" value={reason} onChange={(event) => setReason(event.target.value)} className="rounded border border-border px-2 py-1 text-sm" />
    <button type="submit" disabled={action.isPending} className="rounded bg-primary px-2 py-1 text-sm text-white">{label}</button>
    <button type="button" className="text-sm text-muted" onClick={() => setOpen(false)}>Cancel</button>
    {action.error && <span role="alert" className="text-sm text-destructive">{action.error.message}</span>}
  </form>;
}
