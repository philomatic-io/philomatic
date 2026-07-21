/**
 * Best-effort TeX → Unicode for the snippet-markdown contract's math tokens (owner feedback,
 * 2026-07-18: raw `\bot`/`\forall` doesn't read as math). Deliberately NOT a typesetter — a
 * translation of the common command vocabulary to real glyphs, so `R\bot A` reads `R ⊥ A`
 * everywhere (including the self-contained export) at zero dependency cost. KaTeX remains the
 * documented opt-in when true layout (fractions, limits) is wanted; the raw TeX always
 * survives in the token's title attribute. Unknown commands pass through visibly — honesty
 * over guessing.
 */

const COMMANDS: Record<string, string> = {
  // Greek (the working set)
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Logic & sets
  forall: '∀', exists: '∃', neg: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', setminus: '∖',
  bot: '⊥', perp: '⊥', top: '⊤', mid: '∣', parallel: '∥',
  // Relations & operators
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
  sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫', pm: '±', mp: '∓',
  times: '×', cdot: '⋅', div: '÷', ast: '∗', circ: '∘', oplus: '⊕', otimes: '⊗',
  // Arrows
  to: '→', rightarrow: '→', leftarrow: '←', mapsto: '↦', Rightarrow: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', leftrightarrow: '↔', implies: '⇒', iff: '⇔', uparrow: '↑', downarrow: '↓',
  // Big operators & misc
  sum: '∑', prod: '∏', int: '∫', oint: '∮', partial: '∂', nabla: '∇', infty: '∞',
  sqrt: '√', angle: '∠', therefore: '∴', because: '∵', dots: '…', ldots: '…', cdots: '⋯',
  ddots: '⋱', vdots: '⋮',
  // Style/layout switches are presentation, not content
  bf: '', it: '', rm: '', sf: '', tt: '', cal: '', displaystyle: '', textstyle: '', scriptstyle: '', limits: '', nolimits: '',
  prime: '′', degree: '°', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  // Operator names typeset as words (KaTeX/AMS \log-style commands)
  log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  max: 'max', min: 'min', sup: 'sup', inf: 'inf', lim: 'lim', arg: 'arg', det: 'det',
  gcd: 'gcd', deg: 'deg', dim: 'dim', ker: 'ker', mod: 'mod', Pr: 'Pr',
};

/** Single-char accent commands → combining marks (\hat{y} → ŷ); wider bodies stay visible. */
const ACCENTS: Record<string, string> = {
  hat: '\u0302', bar: '\u0304', tilde: '\u0303', vec: '\u20d7', dot: '\u0307', ddot: '\u0308',
  overline: '\u0304', breve: '\u0306', check: '\u030c',
};

const BLACKBOARD: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ', H: 'ℍ' };

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸',
  '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ', '*': '*',
};
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈',
  '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ',
  j: 'ⱼ', k: 'ₖ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', t: 'ₜ', x: 'ₓ',
};

const script = (body: string, table: Record<string, string>, marker: string): string => {
  const chars = [...body];
  if (chars.every((c) => table[c] !== undefined)) return chars.map((c) => table[c]!).join('');
  return `${marker}${body}`; // not fully scriptable → keep visible (^2x stays honest)
};

export function texToUnicode(tex: string): string {
  let s = tex;
  // Environments are layout (\begin{aligned}…\end{aligned}); their alignment markers too.
  s = s.replace(/\\(?:begin|end)\s*\{[A-Za-z*]+\}/g, '');
  s = s.replace(/(?<!\\)&/g, ' ');
  // Accents on a single character become combining marks.
  s = s.replace(/\\([A-Za-z]+)\s*\{(\S)\}/g, (whole, name: string, ch: string) =>
    ACCENTS[name] !== undefined ? `${ch}${JSON.parse(`"${ACCENTS[name]}"`)}` : whole,
  );
  // Wrappers whose braces just group text.
  s = s.replace(/\\(?:operatorname|text|mathrm|mathbf|textbf|mathit|boldsymbol)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\mathbb\s*\{([^{}]*)\}/g, (_, b: string) => [...b].map((c) => BLACKBOARD[c] ?? c).join(''));
  // Super/subscripts FIRST (braced then single-char) — converting ^{2} to ² clears the inner
  // braces that would otherwise defeat the fraction regex on \frac{(n^{2}+n)…}{…}.
  s = s.replace(/\^\{([^{}]*)\}/g, (_, b: string) => script(b, SUP, '^'));
  s = s.replace(/_\{([^{}]*)\}/g, (_, b: string) => script(b, SUB, '_'));
  s = s.replace(/\^(\S)/g, (_, c: string) => SUP[c] ?? `^${c}`);
  s = s.replace(/_(\S)/g, (_, c: string) => SUB[c] ?? `_${c}`);
  // Simple one-level fractions: \frac{a}{b} → a/b (parenthesized when compound).
  for (let i = 0; i < 3; i += 1) {
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a: string, b: string) => {
      const wrap = (x: string): string => (/^[\w\\]+$/.test(x.trim()) ? x.trim() : `(${x.trim()})`);
      return `${wrap(a)}/${wrap(b)}`;
    });
  }
  // \left / \right are layout only; \\ is a line break in our one-line tokens.
  s = s.replace(/\\left|\\right/g, '').replace(/\\\\/g, ' ');
  // The command vocabulary. TeX consumes one space after a command name (it's a lexer
  // separator, not content) — do the same, so \sigma ^{2} reads σ² not 'σ ²'.
  s = s.replace(/\\([A-Za-z]+) ?/g, (whole, name: string) => COMMANDS[name] ?? whole);
  // Spacing commands and escaped braces/backslash-space.
  s = s.replace(/\\qquad ?/g, '  ').replace(/\\quad ?/g, ' ');
  s = s.replace(/\\[,;:]/g, ' ').replace(/\\!/g, '').replace(/\\ /g, ' ');
  s = s.replace(/\\\{/g, '{').replace(/\\\}/g, '}');
  // Grouping braces that survived are noise in a translated token.
  s = s.replace(/[{}]/g, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}
