import { useId, useState } from "react";
import { ChartNoAxesCombined, ChevronRight, Table2 } from "lucide-react";
import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { InlineDataChart } from "./data/InlineDataChart";

export function DataResultChip({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const queryId = useId();
  const result = message.dataResult;
  if (!result) return null;
  const chart = result.kind === "chart";
  const Icon = chart ? ChartNoAxesCombined : Table2;
  return (
    <div data-data-result={result.cardId} className="w-full max-w-[min(var(--chat-prose-max),var(--chat-card-pct))] overflow-hidden rounded-xl border border-hairline/40 bg-panel text-sm">
      <div className="flex items-center gap-3 px-3 py-2">
        <Icon size={16} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
        {result.sql ? <button type="button" aria-expanded={expanded} aria-controls={queryId}
          onClick={() => setExpanded(!expanded)} className="flex min-w-0 items-center gap-1.5 rounded text-left text-ink hover:text-accent focus-visible:outline-accent">
          <span className="truncate" title={result.title}>{result.title}</span>
          <ChevronRight size={13} className={`shrink-0 text-ink-tertiary ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        </button> : <span className="min-w-0 truncate text-ink" title={result.title}>{result.title}</span>}
      </div>
      {result.sql && expanded && <div id={queryId} className="border-t border-hairline/40 px-3 py-2">
        <div className="mb-1 text-[11px] font-medium text-ink-secondary">{t("data.card.sql")}</div>
        <pre dir="ltr" className="max-h-64 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink"><code>{result.sql}</code></pre>
      </div>}
      {chart && <InlineDataChart botId={result.botId} cardId={result.cardId} title={result.title} />}
    </div>
  );
}
