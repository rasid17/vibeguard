# Spec — Reading List

## Problem

Orang yang banyak membaca artikel online kehilangan jejak tautan yang ingin dibaca nanti. Bookmark browser menumpuk tanpa status, konteks, atau cara cepat menemukan kembali bacaan yang relevan.

## Goals

- Memungkinkan pengguna menyimpan tautan dengan judul dan catatan singkat.
- Menampilkan daftar bacaan dengan status belum dibaca, sedang dibaca, dan selesai.
- Menjaga data tetap privat per akun.

## Non-goals

- Tidak mengambil konten penuh artikel atau membuat ringkasan otomatis pada iterasi ini.
- Tidak ada aplikasi mobile native.
- Tidak ada berbagi daftar publik atau fitur sosial.

## Users

Pekerja pengetahuan yang mengumpulkan artikel dari browser dan ingin meninjaunya di satu tempat.

## Requirements

- Setiap pengguna hanya bisa melihat dan mengubah daftar miliknya sendiri.
- Form tambah tautan menerima URL valid, judul, dan catatan opsional.
- Status bacaan dapat diubah dari daftar tanpa membuka halaman detail.
- Daftar kosong menampilkan petunjuk cara menambah bacaan pertama.

## Acceptance criteria

- [ ] Pengguna yang sudah login dapat menambah tautan dan melihatnya di daftar.
- [ ] Pengguna tidak dapat mengakses atau mengubah bacaan milik akun lain.
- [ ] Mengubah status dari "belum dibaca" ke "selesai" tersimpan setelah halaman dimuat ulang.
- [ ] URL yang tidak valid ditolak dengan pesan yang jelas, bukan error 500.
- [ ] Daftar kosong menampilkan empty state, bukan area kosong tanpa penjelasan.

## Technical notes

- Frontend memakai komponen form dan tombol yang sudah ada.
- Data disimpan di database melalui service layer; route tidak berisi query langsung.
- Validasi URL dan kepemilikan data dilakukan di server.
- Gunakan data seed lokal untuk pengembangan UI sebelum backend selesai.

## Risks

- Pengambilan metadata URL bisa menambah ketergantungan jaringan; iterasi ini menyimpan judul dari input pengguna saja.
- Perubahan status yang optimistis bisa gagal tanpa pesan; sediakan rollback dan toast error.

## Open questions

- Apakah nanti perlu impor bookmark dari browser? Belum masuk cakupan MVP.
