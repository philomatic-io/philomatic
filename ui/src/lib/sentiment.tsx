/**
 * The sentiment vocabulary — DECLARED by the core framework (model v2 D7/D8: the framework file
 * owns overlay metadata vocabularies; `ui/src/generated/framework.ts` is its baked copy), with
 * icons mapped here (icons are presentation, not vocabulary). The ENGINE stays agnostic
 * (sentiment is a free string, DATA_MODEL §3); unknown/legacy values display verbatim, no icon.
 */
import { Brain, ChatCircle, Lightbulb, Question, type Icon as PhosphorIcon } from '@phosphor-icons/react';
import { FRAMEWORKS } from '../generated/framework';

export interface SentimentChoice {
  token: string;
  label: string;
  Icon: PhosphorIcon;
}

const ICONS: Record<string, PhosphorIcon> = { aha: Lightbulb, confused: Question, pondering: Brain };

// Widened view of the as-const baked tuples (they're heterogeneous across frameworks).
interface MetadataFieldView {
  name: string;
  on: { type: string };
  vocabulary?: readonly { token: string; label?: string }[];
}

const VOCAB: readonly { token: string; label?: string }[] =
  FRAMEWORKS.flatMap((f): readonly MetadataFieldView[] => f.metadataFields).find(
    (m) => m.on.type === 'ANNOTATES' && m.name === 'sentiment',
  )?.vocabulary ?? [];

export const SENTIMENTS: SentimentChoice[] = VOCAB.map((v) => ({
  token: v.token,
  label: v.label ?? v.token,
  Icon: ICONS[v.token] ?? ChatCircle,
}));

export const sentimentOf = (token: string): SentimentChoice | undefined => SENTIMENTS.find((s) => s.token === token);

/** Inline display: icon + label for a known sentiment, otherwise the raw string. */
export function SentimentTag({ token }: { token: string }) {
  const s = sentimentOf(token);
  if (!s) return <span>{token}</span>;
  const { Icon } = s;
  return (
    <span className="sentiment-tag">
      <Icon size={15} /> {s.label}
    </span>
  );
}
