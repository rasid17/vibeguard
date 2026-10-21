# VibeGuard

Quality gate lokal untuk vibe coding. VibeGuard tidak membuat aplikasi untuk Anda; ia memastikan coding agent bekerja dari spec yang jelas, mendapat konteks yang relevan, dan tidak bisa menandai task selesai tanpa bukti verifikasi.

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
| Verify | Menjalankan semua checks, slop scan, dan strict scope guard |
| Evidence | `complete` hanya menerima verifikasi yang lulus dan fingerprint working tree masih sama |

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

## Loop kerja

### Lewat coding agent + MCP

Setelah `init`, restart sesi agent agar MCP terbaca, lalu minta agent mengikuti alur:

```
vibeguard_get_next_task
→ jika checkpoint.needed: berhenti, minta manusia menguji
vibeguard_get_context { taskId }
→ baca file yang relevan
vibeguard_start_task { taskId }
→ implementasi HANYA task itu
vibeguard_verify_task { taskId }
→ perbaiki semua kegagalan
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
| `vibeguard_verify_task` | jalankan checks, slop, scope; mendukung `async: true` |
| `vibeguard_verification_status` | cek job verifikasi async |
| `vibeguard_complete_task` | gate completion dengan evidence segar |
| `vibeguard_fail_task` | catat task gagal/blocked |
| `vibeguard_add_task` | tambah task (acceptance wajib) |

### Lewat terminal

```sh
vibeguard task next
vibeguard task start T-001
vibeguard context T-001
# implementasi
vibeguard task verify T-001
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
    ├── config.json               # checks, slop, context
    ├── spec.md                   # source of truth
    ├── tasks.json                # task, status, evidence pointer
    ├── agent-protocol.md
    ├── context/T-001.md          # context pack terakhir
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
    "strictScope": true,
    "commandTimeoutMs": 300000
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
- Spec dan acceptance/scope task di-hash saat start. Mengubahnya di tengah task akan memblokir verifikasi; start ulang task setelah perubahan disetujui manusia.
- **`required: false`** menjalankan check sebagai informasi, tidak memblokir.
- **`errors`** memblokir verifikasi; **`warnings`** hanya dilaporkan.
- Pattern slop berupa teks literal. Format `/regex/i` juga didukung.
- `.env`, file secret, lockfile, dan `node_modules` tidak dimasukkan ke context pack secara default.
- **Perintah di `commands` dijalankan dengan shell di repo.** Hanya pakai konfigurasi yang Anda percaya.

`init` mendeteksi checks dari `package.json` (npm/pnpm/yarn/bun), `Cargo.toml`, `go.mod`, dan konfigurasi Python sederhana. Jika project tidak punya script yang cocok, edit config manual; verifikasi tanpa commands akan gagal.

## Kenapa evidence tidak bisa dipalsukan

`verify` menghitung fingerprint dari isi working tree (file tracked + untracked, tanpa `.vibeguard`) dan contract hash dari spec + acceptance/scope task. `complete` menghitung ulang keduanya:

- jika kode berubah setelah verify, complete ditolak
- jika spec atau kontrak task berubah setelah verify, complete ditolak
- jika spec diubah setelah task dimulai, verify ditolak sampai task di-start ulang
- jika task belum punya verifikasi lulus, complete ditolak
- jika command wajib gagal, slop error, strict scope dilanggar, atau spec tidak valid, verify gagal

Ini bukan jaminan kode benar. Ini jaminan bahwa **bukti yang dipakai untuk menyatakan selesai adalah bukti untuk kode, spec, dan scope yang benar-benar diverifikasi**.

## Batasan saat ini

- Tidak ada LLM bawaan. Perencanaan dilakukan oleh agent Anda lewat `vibeguard plan` atau MCP.
- Belum ada visual regression/screenshot review. Slop scan masih berbasis teks dan scope.
- Dashboard belum mengedit spec; spec sengaja human-owned lewat editor.
- Verifikasi di dashboard berjalan sinkron. Untuk test panjang, pakai MCP async atau CLI.
- Satu task aktif per project. Belum ada orkestrasi paralel/merge queue.
- Deteksi scope membutuhkan git. Tanpa git, fingerprint tetap bekerja tetapi scope check hanya best-effort.

## Keamanan dan privasi

- Dashboard hanya listen loopback dan membutuhkan token acak; POST juga memeriksa Origin.
- Tidak ada network call, analytics, atau billing.
- Raw source code tidak dikirim ke mana pun. Context pack dibuat lokal.
- Jangan menaruh secret di `spec.md` atau task; context pack akan memasukkannya.
- Log test dapat berisi output sensitif. `runs/` diabaikan git secara default.
- Backup `AGENTS.md`/`CLAUDE.md`/MCP config lama disimpan di `.vibeguard/backups/` saat init mengubahnya.

## Development

```sh
npm test        # 25 test: core, verification, contract, context, MCP, HTTP, CLI
npm run check   # test + help
```

Tidak ada dependency runtime. Semua modul memakai Node built-ins.

## Hubungan dengan tool lain

VibeGuard melengkapi, bukan menggantikan:

- `ai-planner-framework` — dokumen rencana dan prompt arsitek/reviewer
- `orchestra-kit` — delegasi multi-agent dan routing model
- VibeGuard — gate spec/task/evidence yang memastikan pekerjaan agent bisa dipercaya

Kalau agent Anda sudah punya planner dan orkestrator, pakai VibeGuard sebagai lapisan verifikasi terakhir.
