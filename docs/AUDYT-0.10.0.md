# Audyt Vytty 0.9.1 → 0.10.0

Data: 17.11.2026. Zakres: cały kod (proces główny, preload, renderer), skrypty budowania, launcher NSIS, workflow
GitHub Actions, zależności (`npm audit`) i działanie aplikacji: testy automatyczne oraz przejście interfejsu
w Electronie uruchomionym bez ekranu. Każdy punkt oznaczony jako naprawiony ma test w `test/`, chyba że opisano inaczej.

Ważność: **W** wysoka, **Ś** średnia, **N** niska, **I** informacyjna.

## Bezpieczeństwo i EDR (CrowdStrike, Defender for Endpoint)

| # | Ważność | Problem | Stan |
| --- | --- | --- | --- |
| A1 | W | Niepodpisane pliki `.exe` (launcher i `Vytty.exe`). Modele ML EDR oceniają każde wydanie od zera | Pipeline gotowy na SignPath / `.pfx` / Azure. Wymaga Twojego działania, patrz [PODPISYWANIE.md](PODPISYWANIE.md) |
| A2 | W | Drag-out SFTP uruchamiał ukryty `powershell.exe -NoProfile -NonInteractive` z `Shell.Application` (COM), żeby odczytać foldery otwarte w Eksploratorze. Klasyczny wzorzec IOA | Naprawione: obserwacja folderów profilu przez `fs.watch`, bez procesów potomnych |
| A3 | W | Aktualizacja wersji zip rozpakowywana przez `tar.exe` (LOLBin) | Naprawione: rozpakowywanie w procesie (yauzl, ochrona przed zip-slip) |
| A4 | W | Aktualizacje bez weryfikacji (sprawdzany tylko rozmiar). Podmieniony plik na serwerze lub złośliwe proxy TLS mogło podsunąć dowolny program | Naprawione: `SHA256SUMS.txt` + podpis Ed25519 z kluczem w aplikacji; odmowa przy niezgodności; ochrona przed cofnięciem wersji |
| A5 | Ś | Launcher NSIS używał wtyczki `System` (DLL rozpakowywany do `%TEMP%` i ładowany przy każdym starcie) do ustawienia zmiennych środowiskowych | Naprawione: ścieżka przekazywana argumentem `--vytty-portable-exe=`; launcher bez wtyczek (sprawdzone kompilacją makensis) |
| A6 | Ś | Aktualizacja portable zmieniała nazwę i podmieniała plik `.exe`. Gdy EDR zablokował nowy plik, nie zostawała żadna działająca wersja | Naprawione: nowa wersja obok starej, stara usuwana dopiero po udanym starcie nowej |
| A7 | Ś | Spakowaną aplikację dało się uruchomić jako interpreter Node (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`), czyli użyć jej jako LOLBina | Naprawione: Electron fuses. Dodatkowo kontrola integralności `app.asar` i ładowanie tylko z asar (sprawdzone na buildzie) |
| A8 | W | Electron 44.4.5 z opublikowanymi podatnościami (m.in. przypisanie uprawnień pointer lock do złej ramki, skompromitowane certyfikaty pośrednie eMudhra) | Naprawione: 44.11.3 |
| A9 | N | Ostrzeżenia `npm audit` w narzędziach budowania (undici, fast-uri, minimatch w electron-builder) | undici i fast-uri poprawione; minimatch tylko w narzędziach budowania, nie trafia do aplikacji |
| A10 | Ś | IPC `shell:openPath` otwierało dowolną ścieżkę (dla pliku `.exe` oznacza to uruchomienie) | Naprawione: tylko istniejące foldery |
| A11 | N | Brak obsługi uprawnień webowych, brak blokady `<webview>`, łagodniejszy CSP | Naprawione: wszystkie uprawnienia odrzucane, webview wyłączony, nawigacja blokowana dla każdego okna, CSP z `object-src 'none'`, `base-uri 'none'`, `frame-src 'none'` |
| A12 | N | Plik ustawień o błędnych typach lub z kluczem `__proto__` mógł zepsuć interfejs | Naprawione: wartości o złym typie wracają do domyślnych, klucze prototypu są ignorowane |
| A13 | I | Limit 60 zapytań/h do API GitHuba na adres IP (cała firma za jednym NAT-em) | Naprawione: zapasowe ustalanie wersji przez przekierowanie strony wydań |
| A14 | I | Wydania nie miały sum kontrolnych ani dowodu pochodzenia | Naprawione: `SHA256SUMS.txt`, podpis i atestacje (`gh attestation verify`) |

## Błędy funkcjonalne

| # | Problem | Stan |
| --- | --- | --- |
| B1 | SSH przez jump host: gdy cel był nieosiągalny, połączenie z jump hostem zostawało otwarte | Naprawione + test |
| B2 | Zamknięcie karty w trakcie łączenia SSH zostawiało połączenie działające w tle | Naprawione |
| B3 | Telnet nie miał limitu czasu łączenia (czekał na timeout TCP systemu, na Linuksie minuty) | Naprawione + test |
| B4 | Komunikat „Private key not found” zawierał surowe bajty ESC i samo LF | Naprawione |
| B5 | Dwukrotne zamknięcie połączonej karty (dwa okna potwierdzenia) zamykało inną kartę: `splice(-1)` | Naprawione |
| B6 | „Save as session…” zapisywało sesję nawet po anulowaniu okna | Naprawione: okno wypełnione danymi, zapis dopiero po „Save”; karta przypina się do nowej sesji |
| B7 | Import pliku Vytty mógł przepiąć jump hosty istniejących sesji o tych samych identyfikatorach | Naprawione |
| B8 | Sesja z nieznanym protokołem w `sessions.json` psuła całe drzewo sesji | Naprawione |
| B9 | Uszkodzony wpis w `localStorage` wyłączał panel sesji | Naprawione |
| B10 | Po drag-oucie z SFTP opcja „Choose folder…” pobierała z aktywnej karty zamiast z karty, z której przeciągnięto plik | Naprawione |
| B11 | Upload SFTP: błąd `realpath` kończył się nieobsłużonym wyjątkiem | Naprawione |
| B12 | Kopie tymczasowe drag-outu (potrafią mieć gigabajty) zostawały do zamknięcia programu | Naprawione: usuwane po zamknięciu połączenia |
| B13 | xterm 6: czarny pasek pod ostatnim wierszem terminala (natywny pasek przewijania włączony przez `scrollbar-width: thin`) | Naprawione |
| B14 | Zapis ustawień, sesji i sejfu mógł się nie udać (EPERM), gdy antywirus na chwilę blokował plik | Naprawione: ponawianie zapisu i `fsync` |
| B15 | Import MobaXterm: ścieżki kluczy z `_ProfileDir_` nierozwinięte, bramki SSH zapisywane tylko w notatkach | Naprawione: bramki stają się sesjami jump host |

## Wydajność

- Dane z sesji trafiały do okna osobnym komunikatem IPC dla każdego kawałka. Teraz porcje z jednej serii są
  łączone (`setImmediate`, bez opóźniania echa przy pisaniu).

## Co zostaje (świadome ryzyka)

- **Brak podpisu Authenticode**, dopóki nie przejdziesz procesu z [PODPISYWANIE.md](PODPISYWANIE.md).
- Tryb sejfu „bez hasła głównego” to zaciemnienie, nie szyfrowanie. Aplikacja wyraźnie o tym informuje.
- Klucze hostów SSH działają w modelu TOFU (zaufanie przy pierwszym połączeniu, głośne ostrzeżenie przy zmianie).
- Drag-out SFTP rozpoznaje upuszczenie w folderach profilu użytkownika (Pulpit, Pobrane, Dokumenty, OneDrive,
  projekty). Po upuszczeniu na inny dysk Vytty pyta o folder.
- Klucz podpisujący aktualizacje jest w sekretach GitHuba. Bezpieczeństwo aktualizacji zależy więc od
  bezpieczeństwa konta GitHub (2FA, reguła ograniczająca tworzenie tagów `v*`).

## Testy

- `npm test`: 47 testów jednostkowych i integracyjnych. Obejmują weryfikację aktualizacji i pełną ścieżkę
  aktualizacji AppImage (w tym odrzucenie podmienionego pliku i fałszywego podpisu), rozpakowywanie zip, wszystkie
  importery i eksporty, NetBox, narzędzia zewnętrzne, linki, sejf, ustawienia, logi, podświetlanie, drag-out oraz
  sesje SSH (klucze hosta, jump host, wyciek przy błędzie) i Telnet (NAWS, auto-login, timeout) na prawdziwych
  serwerach testowych.
- `npm run test:e2e`: uruchamia aplikację bez ekranu i przechodzi interfejs: konfigurację sejfu, sesje, lokalną
  powłokę, logowanie SSH przez okna klucza hosta i hasła (z zapisem w sejfie), style i ustawienia.
- W CI każdy build (Windows, Linux) jest raz uruchamiany ze `--smoke-test`, więc wydanie, które się nie
  uruchamia, nie zostanie opublikowane.
