import { VibeError } from './util.js';

const SECTION_DEFS = [
  { key: 'problem', label: 'Problem / latar belakang', aliases: ['problem', 'problem statement', 'masalah', 'latar belakang', 'background'], required: true },
  { key: 'goals', label: 'Goals / tujuan', aliases: ['goals', 'goal', 'tujuan', 'objectives', 'objektif'], required: false },
  { key: 'nonGoals', label: 'Non-goals / di luar cakupan', aliases: ['non-goals', 'non goals', 'nongoals', 'non-tujuan', 'bukan tujuan', 'out of scope', 'di luar scope', 'di luar cakupan'], required: true },
  { key: 'users', label: 'Users / pengguna', aliases: ['users', 'target users', 'pengguna', 'target pengguna', 'personas', 'persona'], required: false },
  { key: 'requirements', label: 'Requirements / kebutuhan', aliases: ['requirements', 'requirement', 'kebutuhan', 'functional requirements', 'fitur', 'features', 'scope'], required: false },
  { key: 'acceptance', label: 'Acceptance criteria / kriteria penerimaan', aliases: ['acceptance criteria', 'acceptance', 'kriteria penerimaan', 'definisi selesai', 'definition of done', 'done criteria'], required: true },
  { key: 'tech', label: 'Technical notes / arsitektur', aliases: ['technical notes', 'technical', 'teknologi', 'tech stack', 'arsitektur', 'architecture'], required: false },
  { key: 'risks', label: 'Risks / risiko', aliases: ['risks', 'risk', 'risiko'], required: false },
  { key: 'questions', label: 'Open questions / pertanyaan terbuka', aliases: ['open questions', 'questions', 'pertanyaan terbuka', 'pertanyaan'], required: false }
];

const OVERVIEW_ALIASES = ['overview', 'ringkasan', 'summary'];

function normalizeHeading(value) {
  return String(value)
    .toLowerCase()
    .replace(/^\s*\d+[.)]?\s*/, '')
    .replace(/[*_`#]/g, '')
    .replace(/[:：]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSection(normalized) {
  let best = null;
  for (const definition of SECTION_DEFS) {
    for (const alias of definition.aliases) {
      if (normalized === alias || normalized.startsWith(`${alias} `) || normalized.startsWith(`${alias}-`) || normalized.startsWith(`${alias}/`)) {
        if (!best || alias.length > best.alias.length) best = { definition, alias };
      }
    }
  }
  if (best) return best.definition;
  if (OVERVIEW_ALIASES.some((alias) => normalized === alias || normalized.startsWith(`${alias} `))) {
    return { key: 'problem', label: SECTION_DEFS[0].label, aliases: OVERVIEW_ALIASES, required: true, inferred: true };
  }
  return null;
}

export function parseSpec(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const headings = [];
  let inFence = false;
  let fenceMarker = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) headings.push({ level: heading[1].length, text: heading[2], line: index });
  }

  const titleHeading = headings.find((heading) => heading.level === 1);
  const sections = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading.level === 1) continue;
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLine = next ? next.line : lines.length;
    const content = lines.slice(heading.line + 1, endLine).join('\n').trim();
    const normalized = normalizeHeading(heading.text);
    const definition = matchSection(normalized);
    if (definition) {
      sections.push({
        key: definition.key,
        label: definition.label,
        heading: heading.text,
        line: heading.line + 1,
        content
      });
    }
  }

  return {
    title: titleHeading?.text?.trim() || '',
    titleLine: titleHeading ? titleHeading.line + 1 : 0,
    sections,
    lines
  };
}

function stripTemplateComments(content) {
  return String(content ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function isMeaningful(content) {
  const cleaned = stripTemplateComments(content)
    .replace(/[#>*_`~\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 20;
}

function findPlaceholders(markdown) {
  const hits = [];
  const lines = String(markdown ?? '').split(/\r?\n/);
  const patterns = [
    { regex: /<!--/, reason: 'komentar template belum dihapus' },
    { regex: /\b(TODO|TBD|FIXME)\b/i, reason: 'masih ada TODO/TBD/FIXME' },
    { regex: /\[(isi|tulis|jelaskan|uraikan|ganti|contoh)\b[^\]]*\]/i, reason: 'placeholder instruksi belum diganti' },
    { regex: /lorem ipsum/i, reason: 'teks placeholder lorem ipsum' }
  ];
  const fenceLines = new Set();
  let inFence = false;
  let marker = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        marker = fence[1][0];
        fenceLines.add(index);
      } else if (fence[1][0] === marker) {
        inFence = false;
        marker = '';
        fenceLines.add(index);
      }
      continue;
    }
    if (inFence) fenceLines.add(index);
  }
  lines.forEach((line, index) => {
    if (fenceLines.has(index)) return;
    for (const pattern of patterns) {
      if (pattern.regex.test(line)) {
        hits.push({ line: index + 1, text: line.trim().slice(0, 180), reason: pattern.reason });
        break;
      }
    }
  });
  return hits;
}

export function checkSpec(markdown) {
  const parsed = parseSpec(markdown);
  const missing = [];
  const empty = [];
  const warnings = [];
  const byKey = new Map();
  for (const section of parsed.sections) {
    if (!byKey.has(section.key)) byKey.set(section.key, section);
  }

  if (!parsed.title || !parsed.title.replace(/spec|prd|—|-/gi, '').trim()) {
    missing.push({ key: 'title', label: 'Judul spec' });
  }

  for (const definition of SECTION_DEFS) {
    const section = byKey.get(definition.key);
    if (!section) {
      if (definition.required) missing.push({ key: definition.key, label: definition.label });
      else warnings.push(`Bagian "${definition.label}" belum ada.`);
      continue;
    }
    if (!isMeaningful(section.content)) {
      empty.push({ key: definition.key, label: definition.label, line: section.line });
    }
  }

  const placeholders = findPlaceholders(markdown);
  const acceptance = byKey.get('acceptance');
  if (acceptance && !/(?:^|\n)\s*(?:[-*]|\d+[.)]|given\b|when\b|then\b)/im.test(acceptance.content)) {
    warnings.push('Acceptance criteria sebaiknya berupa daftar atau format Given/When/Then yang bisa diuji.');
  }
  if (!byKey.get('users')) warnings.push('Target pengguna belum disebutkan; ini sering membuat UI/AI menebak.');
  if (!byKey.get('goals')) warnings.push('Goals belum disebutkan; sulit menilai apakah hasilnya tepat.');
  if (!byKey.get('requirements')) warnings.push('Requirements belum disebutkan; pastikan acceptance criteria cukup spesifik.');
  if (!byKey.get('tech')) warnings.push('Technical notes belum ada; agent akan memilih stack sendiri.');

  return {
    ok: missing.length === 0 && empty.length === 0 && placeholders.length === 0,
    title: parsed.title,
    sections: parsed.sections,
    missing,
    empty,
    placeholders,
    warnings
  };
}

export function specTemplate(projectName = 'project') {
  return `# Spec — ${projectName}

<!--
Sumber kebenaran tunggal untuk proyek ini.
Isi semua bagian, lalu hapus komentar HTML di file ini.
VibeGuard menolak spec yang masih berisi TODO, TBD, FIXME, atau komentar template.
-->

## Problem
<!-- Siapa yang bermasalah, dalam situasi apa, dan kenapa cara sekarang gagal? -->
-

## Goals
<!-- Hasil yang ingin dicapai, terukur bila memungkinkan. -->
-

## Non-goals
<!-- Hal yang sengaja TIDAK dikerjakan pada iterasi ini. Wajib diisi. -->
-

## Users
<!-- Siapa penggunanya dan apa yang mereka butuhkan. -->
-

## Requirements
<!-- Perilaku sistem yang wajib ada. Sebutkan data, aturan akses, dan edge case penting. -->
-

## Acceptance criteria
<!-- Daftar yang bisa diverifikasi. Gunakan Given/When/Then bila membantu. -->
- [ ]

## Technical notes
<!-- Stack, pola arsitektur, batasan, dan keputusan teknis yang sudah disepakati. -->
-

## Risks
<!-- Risiko teknis/produk dan mitigasinya. -->
-

## Open questions
<!-- Pertanyaan yang harus dijawab manusia sebelum implementasi. -->
-
`;
}

export function specSummary(markdown) {
  const parsed = parseSpec(markdown);
  const problem = parsed.sections.find((section) => section.key === 'problem');
  return {
    title: parsed.title || 'Untitled spec',
    problem: problem ? stripTemplateComments(problem.content).slice(0, 240) : '',
    sectionCount: parsed.sections.length
  };
}

export function assertSpecOk(markdown) {
  const check = checkSpec(markdown);
  if (!check.ok) {
    const details = [
      ...check.missing.map((item) => `missing: ${item.label}`),
      ...check.empty.map((item) => `empty: ${item.label}`),
      ...check.placeholders.map((item) => `line ${item.line}: ${item.reason}`)
    ];
    throw new VibeError('Spec belum lengkap. Lengkapi .vibeguard/spec.md terlebih dahulu.', {
      hint: details.slice(0, 8).join('; ')
    });
  }
  return check;
}
