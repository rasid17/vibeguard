# VibeGuard

Quality gate lokal untuk vibe coding. VibeGuard tidak membuat aplikasi untuk Anda; ia memastikan coding agent bekerja dari spec yang jelas, mendapat konteks yang relevan, dan tidak bisa menandai task selesai tanpa verifikasi serta bukti untuk setiap acceptance criterion.

Dibuat untuk pemakaian pribadi:

- tanpa billing
- tanpa telemetry
- tanpa network call
- semua data di mesin ini
- tetap kompatibel dengan Claude Code, Cursor, Codex, Qwen Code, dan agent lain yang mendukung MCP

## Masalah yang diserang

AI slop biasanya muncul dari empat sumber:

1. **Intent kabur** — agent menebak requirement dan mengarang scope.
2. **Task terlalu besar** — satu prompt menulis seluruh aplikasi.
3. **Konteks salah atau basi** — agent membaca file yang tidak relevan atau memakai API usang.
4. **Output tidak diverifikasi** — agent mengklaim selesai tanpa test, build, atau bukti.

VibeGuard memaksakan lima gerbang:

| Gerbang | Mekanisme |
|---|---|
| Spec | `.vibeguard/spec.md` wajib punya problem, non-goals, dan acceptance criteria; placeholder ditolak |
| Plan | Task wajib punya minimal satu acceptance criterion dan file scope |
| Context | `get_context` menyusun context pack dari spec, konvensi, dan file yang relevan |
| Verify | Menjalankan semua checks, slop scan, secret scan, dan strict scope guard |
| Evidence | `complete` hanya menerima verifikasi lulus, fingerprint + contract hash yang sama, dan bukti untuk setiap acceptance criterion |

Checkpoint antar-layer/fase juga dipaksakan: agent harus berhenti, manusia menguji hasilnya, lalu secara eksplisit menyetujui task berikutnya. Bukan sekadar instruksi prompt — `start_task` akan menolak sampai checkpoint di-acknowledge.

## Quick start

Butuh Node.js 20 atau lebih baru.

```sh
cd /path/to/vibeguard
npm link                 # opsional: membuat command `vibeguard` global

cd ~/project-yang-mau-dijaga
vibeguard init
vibeguard spec edit
```

`init` akan:

- membuat `.vibeguard/` berisi config, spec template, dan task kosong
- mendeteksi script `typecheck`, `lint`, `test`, `build` dari `package.json`
- membuat `AGENTS.md` dan `CLAUDE.md` dengan protokol kerja
- menulis `.mcp.json` berisi MCP server VibeGuard
- tidak menimpa spec yang sudah ada

Lalu isi spec. Spec wajib punya minimal:

- judul
- problem / latar belakang
- non-goals / di luar cakupan
- acceptance criteria

Setelah spec lolos `vibeguard spec check`, tambahkan task:

```sh
vibeguard task add "Halaman login email dan password" \
  --desc "Gunakan pola form yang sudah ada." \
  --criteria "Email dan password valid bisa login" \
  --criteria "Pesan error tampil untuk kredensial salah" \
  --files "src/app/login/**,src/lib/auth/**" \
  --layer frontend \
  --phase 1
```

Atau pakai agent sebagai planner:

```sh
vibeguard plan "Aplikasi pencatat pengeluaran dengan dashboard bulanan"
```

Command ini membuat `.vibeguard/brief.md` dan mencetak prompt siap tempel untuk agent. Agent mengisi spec dan menambahkan task lewat MCP/CLI. Tidak ada panggilan LLM dari VibeGuard sendiri.

Buka dashboard:

```sh
vibeguard ui
# buka URL bertoken yang dicetak di terminal
```

Dashboard listen di `127.0.0.1` dan memakai token acak per proses.

## Mode diskusi: ide sebelum spec

VibeGuard sengaja tidak punya agent atau LLM. Diskusi dua arah tetap dilakukan di Claude Code, Cursor, ChatGPT, atau agent lain. Selama fase diskusi, belum ada verifikasi yang berjalan dan spec boleh masih berupa draft. Gate pertama berlaku saat Anda mulai menambah task: `task add` mewajibkan spec yang valid.

Alur yang disarankan:

```sh
cd ~/project
vibeguard plan "Ide: aplikasi ..."
```

Command ini menulis `.vibeguard/brief.md` dan mencetak prompt. Buka agent di folder project, lalu tempel prompt diskusi:

```text
Baca .vibeguard/brief.md, .vibeguard/spec.md, dan AGENTS.md.
Kita masih fase diskusi. JANGAN menulis kode, JANGAN menambah task,
dan JANGAN memanggil tool task/verify.

Bantu saya mengeksplorasi ide ini:
1. Ulangi pemahamanmu tentang masalah dan target pengguna.
2. Ajukan maksimal 5 pertanyaan yang benar-benar mengubah keputusan.
3. Bandingkan minimal 3 opsi pendekatan, dengan trade-off masing-masing.
4. Sebutkan non-goals, risiko, dan asumsi yang perlu diuji.
5. Rekomendasikan satu opsi dan jelaskan alasannya.

Setelah saya bilang "capture", tulis hasil diskusi ke .vibeguard/spec.md
(problem, goals, non-goals, users, requirements, acceptance criteria,
technical notes, risks, open questions). Simpan keputusan dan opsi yang
ditolak di bagian Technical notes. Hapus semua komentar template/TODO,
lalu jalankan `vibeguard spec check`.
```

Setelah diskusi selesai dan Anda setuju dengan arahannya:

```sh
vibeguard spec check
vibeguard task add "..." --criteria "..." --files "..." --layer frontend --phase 1
# atau minta agent menambahkan task lewat MCP
```

Catatan:

- Jangan menyimpan transkrip chat ke VibeGuard; simpan keputusan dan alasannya di spec. VibeGuard adalah tempat membekukan keputusan, bukan arsip percakapan.
- Taruh keputusan penting di `## Technical notes` atau `## Open questions`. Saat ini context pack mengambil bagian inti spec; bagian tambahan seperti `## Decision` belum tentu ikut ke task berikutnya.
- Untuk agent yang hanya bisa chat di browser dan tidak bisa membaca repo, salin isi spec secara manual. Verifikasi lokal, secret scan, dan evidence tetap harus dijalankan dari repo.
- Untuk pendapat kedua, `delegate.sh plan` atau `review` dari `orchestra-kit` bisa dipakai sebagai one-shot reviewer, bukan pengganti diskusi dua arah.
- Jangan masuk ke loop implementasi sebelum non-goals dan acceptance criteria cukup jelas. Gate pertama adalah `task add`; setelah task ada, verifikasi, scope, dan evidence mulai mengikat.

## Loop kerja

### Lewat coding agent + MCP

Setelah `init`, restart sesi agent agar MCP terbaca, lalu minta agent mengikuti alur:

```
vibeguard_get_next_task
→ jika checkpoint.needed: berhenti, minta manusia menguji
vibeguard_get_context { taskId }
→ baca file yang relevan
vibeguard_graph_impact { target }
→ opsional: lihat dependensi/test sebelum mengubah modul bersama
vibeguard_start_task { taskId }
→ implementasi HANYA task itu
vibeguard_verify_task { taskId }
→ perbaiki semua kegagalan
vibeguard_record_evidence { taskId, criterion: "A1", note, type, ref }
→ buktikan setiap criterion (A1, A2, ...)
vibeguard_complete_task { taskId }
→ commit, lalu berhenti di checkpoint berikutnya
```

Tool yang tersedia:

| Tool | Fungsi |
|---|---|
| `vibeguard_status` | ringkasan project, spec, task, checks |
| `vibeguard_get_spec` | spec + hasil validasi |
| `vibeguard_list_tasks` | daftar task, blocker, evidence |
| `vibeguard_get_next_task` | satu task berikutnya + checkpoint |
| `vibeguard_get_context` | context pack untuk satu task |
| `vibeguard_start_task` | mulai satu task; checkpoint butuh ack |
| `vibeguard_graph_stats` | statistik codegraph: file, simbol, edge, test, top hubs |
| `vibeguard_graph_query` | cari file/simbol dan lihat in/out degree |
| `vibeguard_graph_impact` | reverse-import impact: dependents, transitive importers, tests, risk |
| `vibeguard_verify_task` | jalankan checks, slop, secret, scope; mendukung `async: true` |
| `vibeguard_verification_status` | cek job verifikasi async |
| `vibeguard_record_evidence` | catat bukti untuk satu acceptance criterion (`A1`, `A2`, ...) |
| `vibeguard_complete_task` | gate completion dengan verifikasi segar + evidence lengkap |
| `vibeguard_fail_task` | catat task gagal/blocked |
| `vibeguard_add_task` | tambah task (acceptance wajib) |

### Lewat terminal

```sh
vibeguard task next
vibeguard task start T-001
vibeguard context T-001
# implementasi
vibeguard task verify T-001
vibeguard task evidence T-001 A1 "test auth.test.ts > login valid" --type test --ref "auth.test.ts:42"
vibeguard task done T-001
```

Saat layer/fase berubah:

```sh
# 1. agent berhenti
# 2. Anda menguji aplikasi
# 3. setelah setuju:
vibeguard task start T-002 --acknowledge
```

### Verifikasi yang lambat

MCP client punya batas waktu request. Jika test suite panjang, minta agent memakai:

```json
{ "name": "vibeguard_verify_task", "arguments": { "taskId": "T-001", "async": true } }
```

Lalu polling `vibeguard_verification_status`. Alternatifnya jalankan `vibeguard task verify T-001` di terminal; hasilnya tetap tercatat dan `complete_task` akan membacanya.

## Codegraph

VibeGuard punya codegraph lokal: graph struktural dari file kode, simbol, import, dan test. Ini bukan LSP atau call graph runtime; tujuannya membantu agent memilih konteks dan melihat blast radius sebelum mengubah kode.

Node:

- `file` untuk file kode: JS/TS, JSX/TSX, Vue, Svelte, Python, Go, Rust, SQL, Java/Kotlin, Ruby, PHP, C#/Swift/C/C++.
- `symbol` untuk fungsi, class, type, route, dan simbol lain yang terdeteksi.

Edge:

- `defines`: file → simbol yang didefinisikan.
- `imports`: file → file lokal yang di-import.
- File test ditandai dan tetap terhubung melalui import yang sama.

```sh
vibeguard graph stats
vibeguard graph query auth
vibeguard graph impact src/lib/auth.ts
vibeguard graph impact login --depth 2
vibeguard graph build
vibeguard graph export --format mermaid --target src/lib/auth.ts
```

- `impact` melakukan reverse-import BFS: siapa yang mengimpor target, siapa yang mengimpor mereka, test terkait, dan risk `low`/`medium`/`high`.
- `query` mencari file/simbol beserta in/out degree.
- `build` menyimpan cache graph di `.vibeguard/context/graph.json` (diabaikan git).
- `export` menghasilkan JSON atau Mermaid.

Integrasi:

- `vibeguard context` otomatis menambahkan bagian **Codegraph impact** dan menaikkan prioritas file dependen serta test dalam context pack.
- MCP menyediakan `vibeguard_graph_stats`, `vibeguard_graph_query`, dan `vibeguard_graph_impact`.
- Dashboard punya tab **Codegraph** untuk statistik, pencarian, impact analysis, dan ego-network SVG.

Batasan: graph dibangun dari regex dan bagian awal file, bukan AST/LSP penuh. Import relatif di-resolve; alias seperti `@/` dan package eksternal tidak menjadi edge. Call graph runtime tidak dilacak. Gunakan impact sebagai petunjuk navigasi, bukan jaminan bahwa semua dependensi dinamis tertangkap.

## Integrasi MCP

`init` menulis `.mcp.json` untuk Claude Code:

```json
{
  "mcpServers": {
    "vibeguard": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/vibeguard/bin/vibeguard.js", "mcp", "--project", "/path/to/project"]
    }
  }
}
```

- **Cursor**: `vibeguard agent-config --write --target cursor` menulis `.cursor/mcp.json`.
- **Claude Code / Cursor**: konfigurasi yang sama memakai format `mcpServers`.
- **Codex**: `vibeguard agent-config` mencetak blok `[mcp_servers.vibeguard]` untuk `.codex/config.toml`.
- **Agent lain**: gunakan command `node /path/to/vibeguard/bin/vibeguard.js mcp --project <project>`.

Config MCP memakai path absolut. Jika folder pindah, jalankan ulang `vibeguard agent-config --write`.

## Struktur data

```text
project/
├── AGENTS.md                     # protokol agent (dikelola dengan marker)
├── CLAUDE.md                     # pointer untuk Claude Code
├── .mcp.json
└── .vibeguard/
    ├── config.json               # checks, evidence, slop, secret, context
    ├── spec.md                   # source of truth
    ├── tasks.json                # task, status, evidence A1/A2, run pointer
    ├── agent-protocol.md
    ├── context/T-001.md          # context pack terakhir
    ├── context/graph.json        # cache codegraph (diabaikan git)
    └── runs/
        └── <run-id>/
            ├── task.json
            ├── result.json
            └── 01-test.log
```

`.vibeguard/.gitignore` mengabaikan `runs/`, `context/`, dan `backups/`. Spec, config, dan tasks sebaiknya ikut di-commit.

## Konfigurasi

Edit `.vibeguard/config.json`:

```json
{
  "verification": {
    "commands": [
      { "name": "typecheck", "command": "npm run typecheck", "required": true, "timeoutMs": 300000 },
      { "name": "test", "command": "npm test -- --run", "required": true },
      { "name": "build", "command": "npm run build", "required": true }
    ],
    "requireVerification": true,
    "requireEvidence": true,
    "strictScope": true,
    "commandTimeoutMs": 300000
  },
  "secrets": {
    "enabled": true,
    "ignore": ["**/*.test.*", "**/docs/**", "**/.env*"],
    "patterns": ["/ACME-[0-9]{4}/g"]
  },
  "context": {
    "maxChars": 24000,
    "maxFiles": 2000,
    "exclude": ["legacy/**"]
  },
  "slop": {
    "enabled": true,
    "errors": ["lorem ipsum", "coming soon", "placeholder text"],
    "warnings": ["TODO", "FIXME"],
    "ignore": ["**/*.test.*", "**/docs/**"]
  }
}
```

Hal penting:

- **`strictScope: true`** membuat verifikasi gagal jika ada file berubah di luar `files` task. Butuh git untuk mendeteksi perubahan.
- **`requireEvidence: true`** membuat `complete` menolak task sampai setiap acceptance criterion punya bukti (A1, A2, ...).
- Spec dan acceptance/scope task di-hash saat start. Mengubahnya di tengah task akan memblokir verifikasi; start ulang task setelah perubahan disetujui manusia.
- **`secrets`** memindai file yang berubah (atau semua file teks bila bukan git) untuk token/private key. Pattern bawaan mencakup GitHub, OpenAI, Anthropic, AWS, Google, Stripe, Slack, npm, dan private key. Pattern custom menerima teks literal atau `/regex/flags`.
- **`required: false`** menjalankan check sebagai informasi, tidak memblokir.
- **`errors`** memblokir verifikasi; **`warnings`** hanya dilaporkan.
- Pattern slop berupa teks literal. Format `/regex/i` juga didukung.
- `.env`, file secret, lockfile, dan `node_modules` tidak dimasukkan ke context pack secara default.
- **Perintah di `commands` dijalankan dengan shell di repo.** Hanya pakai konfigurasi yang Anda percaya.

`init` mendeteksi checks dari `package.json` (npm/pnpm/yarn/bun), `Cargo.toml`, `go.mod`, dan konfigurasi Python sederhana. Jika project tidak punya script yang cocok, edit config manual; verifikasi tanpa commands akan gagal.

## Evidence, secret, dan integritas

`verify` menghitung fingerprint dari isi working tree (file tracked + untracked, tanpa `.vibeguard`) dan contract hash dari spec + acceptance/scope task. `complete` menghitung ulang keduanya dan mengecek evidence:

- jika kode berubah setelah verify, complete ditolak
- jika spec atau kontrak task berubah setelah verify, complete ditolak
- jika spec diubah setelah task dimulai, verify ditolak sampai task di-start ulang
- jika task belum punya verifikasi lulus, complete ditolak
- jika salah satu acceptance criterion belum punya bukti, complete ditolak
- jika command wajib gagal, slop error, secret ditemukan, strict scope dilanggar, atau spec tidak valid, verify gagal

Setiap criterion punya ID stabil selama task: `A1`, `A2`, dan seterusnya. Bukti bisa berupa nama test, command, path screenshot, review, atau observasi manual yang spesifik. Ini **attestation**, bukan pembuktian otomatis: VibeGuard memaksa Anda/agent memetakan bukti ke tiap requirement, tetapi kualitas bukti tetap harus dinilai manusia. Secret scanner adalah lapisan tambahan, bukan jaminan bahwa kode bebas dari semua credential.

Saat secret ditemukan, excerpt di log/evidence **di-mask** sehingga token tidak disalin ulang. Jangan menganggap log aman untuk dibagikan; output test tetap bisa mengandung data sensitif.

## Batasan saat ini

- Tidak ada LLM bawaan. Perencanaan dilakukan oleh agent Anda lewat `vibeguard plan` atau MCP.
- Evidence criterion bersifat attestation; VibeGuard tidak bisa menilai apakah test/observasi benar-benar membuktikan requirement.
- Secret scanner berbasis pattern dan mengabaikan test/docs/env secara default; bukan deteksi entropy/ML menyeluruh.
- Codegraph berbasis regex/head, belum AST/LSP penuh; alias import dan dynamic dispatch belum terdeteksi.
- Belum ada visual regression/screenshot review. Slop scan masih berbasis teks dan scope.
- Dashboard belum mengedit spec; spec sengaja human-owned lewat editor.
- Verifikasi di dashboard berjalan sinkron. Untuk test panjang, pakai MCP async atau CLI.
- Satu task aktif per project. Belum ada orkestrasi paralel/merge queue.
- Deteksi scope membutuhkan git. Tanpa git, fingerprint tetap bekerja tetapi scope check hanya best-effort.

## Keamanan dan privasi

- Dashboard hanya listen loopback dan membutuhkan token acak; POST juga memeriksa Origin.
- Tidak ada network call, analytics, atau billing.
- Raw source code tidak dikirim ke mana pun. Context pack dibuat lokal.
- Jangan menaruh secret di `spec.md`, task, atau evidence. Evidence menolak pola token yang dikenal, dan excerpt secret di log di-mask, tetapi tetap jangan menyalin credential ke mana pun.
- Log test dapat berisi output sensitif. `runs/` diabaikan git secara default.
- Backup `AGENTS.md`/`CLAUDE.md`/MCP config lama disimpan di `.vibeguard/backups/` saat init mengubahnya.

## Development

```sh
npm test        # 35 test: core, verification, contract, evidence, secret, codegraph, context, MCP, HTTP, CLI
npm run check   # test + help
```

Tidak ada dependency runtime. Semua modul memakai Node built-ins.

## Hubungan dengan tool lain

VibeGuard melengkapi, bukan menggantikan:

- `ai-planner-framework` — dokumen rencana dan prompt arsitek/reviewer
- `orchestra-kit` — delegasi multi-agent dan routing model
- VibeGuard — gate spec/task/evidence yang memastikan pekerjaan agent bisa dipercaya

Kalau agent Anda sudah punya planner dan orkestrator, pakai VibeGuard sebagai lapisan verifikasi terakhir.
