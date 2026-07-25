/**
 * Kind/modality icons (Phosphor) — the design system specifies Phosphor throughout. Sources
 * render by modality (book / play / headphones / cursor / file); the other kinds by kind. Icons
 * inherit the surrounding colour via currentColor.
 */
import {
  BookOpen,
  CursorClick,
  Diamond,
  FileText,
  Headphones,
  PlayCircle,
  Question,
  Quotes,
  ShareNetwork,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import type { Modality, NodeKind } from '../client/types';

export type IconName = NodeKind | `source:${Modality}`;

const BY_NAME: Record<IconName, PhosphorIcon> = {
  track: ShareNetwork,
  concept: Diamond,
  question: Question,
  snippet: Quotes,
  source: BookOpen,
  'source:text': BookOpen,
  'source:video': PlayCircle,
  'source:audio': Headphones,
  'source:interactive': CursorClick,
  'source:other': FileText,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Comp = BY_NAME[name] ?? BookOpen;
  return <Comp size={size} weight="regular" />;
}

/** Icon name for a source's modality; falls back to text. */
export const sourceIcon = (modality: Modality): IconName => `source:${modality}`;
