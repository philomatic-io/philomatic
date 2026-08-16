/**
 * Declared rendering — the pure rules: polarity classifies into the support/conflict
 * pair from DECLARATIONS (never tag-name literals), subtyped display tags match their bare
 * declaration, and the render reader resolves marks with 'hidden' outranking everything.
 */
import { describe, expect, it } from 'vitest';
import { declaredRender, edgeFamily, familyOf, renderOf } from '../ui/src/lib/edge-families';

describe('polarity → the epistemic pair (real declarations)', () => {
  it('#IsEvidenceFor is the support family; CONTRADICTS stays conflict', () => {
    expect(edgeFamily('LINK', ['#IsEvidenceFor'])).toBe('support');
    expect(edgeFamily('CONTRADICTS')).toBe('conflict');
  });

  it('#Supports / #Opposes classify by their declared polarity — subtypes included', () => {
    expect(edgeFamily('LINK', ['#Supports'])).toBe('support');
    expect(edgeFamily('LINK', ['#Supports:a'])).toBe('support'); // bundle subtype matches the bare declaration
    expect(edgeFamily('LINK', ['#Opposes'])).toBe('conflict');
    expect(edgeFamily('LINK', ['#Opposes:x'])).toBe('conflict');
  });

  it('against outranks for when both ride one edge; undeclared tags stay plain', () => {
    const polarity = new Map<string, 'for' | 'against'>([['Yes', 'for'], ['No', 'against']]);
    expect(familyOf('LINK', ['#Yes', '#No'], polarity)).toBe('conflict');
    expect(familyOf('LINK', ['#Whatever'], polarity)).toBe('plain');
  });
});

describe('renderOf — the declared mark', () => {
  const render = new Map<string, 'line' | 'group' | 'comet' | 'hidden'>([
    ['Grouper', 'group'],
    ['Comet', 'comet'],
    ['Gone', 'hidden'],
  ]);

  it('resolves a tag to its declared mark, subtype included', () => {
    expect(renderOf(['#Grouper'], render)).toBe('group');
    expect(renderOf(['#Comet:a'], render)).toBe('comet');
    expect(renderOf(['#Plain'], render)).toBeUndefined();
  });

  it('hidden outranks any other declared mark on the same edge', () => {
    expect(renderOf(['#Comet', '#Gone'], render)).toBe('hidden');
  });

  it('no framework tag declares a render yet — declaredRender is dormant on real data', () => {
    expect(declaredRender(['#IsEvidenceFor'])).toBeUndefined();
    expect(declaredRender(['#TopicOf'])).toBeUndefined(); // taxonomy groups via hierarchy, not render
  });
});
