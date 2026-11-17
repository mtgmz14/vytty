# Podpisywanie Vytty w Windows i alarmy CrowdStrike

Stan na listopad 2026. Dotyczy wersji 0.10.0.

## Skąd się bierze alarm

Falcon (CrowdStrike) ocenia pliki modelem uczenia maszynowego jeszcze zanim zostaną uruchomione. Wykrycie wygląda
wtedy jak `Win/malicious_confidence_60% (W)` i nie oznacza, że w pliku znaleziono złośliwy kod. Oznacza tylko, że
plik „wygląda podobnie” do złośliwego oprogramowania. Vytty do 0.9.1 zbierało wiele cech, za które takie modele dają punkty:

| Cecha | Do 0.9.1 | Od 0.10.0 |
| --- | --- | --- |
| Brak podpisu Authenticode | tak | nadal tak (pipeline gotowy, patrz niżej) |
| Samorozpakowujący się plik NSIS (~140 MB), który wypakowuje i uruchamia program z `%LOCALAPPDATA%` | tak | nadal tak (wersja `.zip` tego nie robi) |
| Wtyczka NSIS `System.dll` rozpakowywana do `%TEMP%` przy każdym starcie | tak | **nie** |
| Ukryty `powershell.exe` z obiektem COM `Shell.Application` (drag-out z SFTP) | tak | **nie** |
| `tar.exe` (LOLBin) rozpakowujący pliki wykonywalne przy aktualizacji | tak | **nie** |
| Zmiana nazwy i podmiana działającego pliku `.exe` przy aktualizacji | tak | **nie** dla wersji portable (nowa obok starej) |
| Pobieranie plików `.exe` z internetu bez weryfikacji | tak | **nie**: SHA-256 + podpis Ed25519, tryb „tylko powiadamiaj” |
| `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` (aplikację dało się użyć jako interpretera Node) | tak | **nie** (Electron fuses) |

Do pracy na służbowym komputerze polecam paczkę **`Vytty-x.y.z-win-x64.zip`**. Nie zawiera samorozpakowującego się
launchera, więc unikasz najbardziej podejrzanego wzorca. W *Ustawienia → About* ustaw aktualizacje na
**„Only tell me”**. Wtedy Vytty niczego nie pobiera, a nowe wersje ściągasz przeglądarką.

**Najważniejsze: żadna sztuczka w kodzie nie zastąpi podpisu cyfrowego.** Niepodpisany plik, który zmienia się
z każdym wydaniem, zawsze będzie oceniany „od zera”. Podpis daje modelowi silny sygnał zaufania. Pozwala też
działowi bezpieczeństwa dopuścić aplikację po certyfikacie wydawcy zamiast po skrócie każdego pliku, więc kolejne
wersje przechodzą bez nowych zgłoszeń.

## Czy da się podpisać za darmo, tak żeby Windows ufał?

**Tak, są dwie realne drogi.** Żadna nie wymaga płacenia, ale obie wymagają Twojego działania (tożsamość, wniosek).
Nie mogę ich wykonać za Ciebie.

### 1. SignPath Foundation (darmowe dla open source) - rekomendowane

SignPath Foundation bezpłatnie podpisuje projekty open source certyfikatem wydanym przez publiczne CA, któremu ufa
Windows. W podpisie jako wydawca widnieje „SignPath Foundation”, nie Ty. Vytty spełnia warunki:

- licencja OSI bez podwójnego licencjonowania: MIT ✔
- publiczne repozytorium, aktywnie utrzymywane, już wydane w formie, którą się podpisuje ✔
- budowanie na GitHub Actions z kodu repozytorium (weryfikowalne) ✔
- strona „Code signing policy” z wymaganym dopiskiem oraz informacja o prywatności: dodane w [SECURITY.md](../SECURITY.md)
  i podlinkowane z README ✔
- **do zrobienia przez Ciebie**: MFA na GitHubie i w SignPath dla każdej osoby z dostępem oraz ręczne zatwierdzanie
  każdego podpisu (dwa kliknięcia na wydanie: `Vytty.exe` i launcher)

Krok po kroku:
1. Włącz uwierzytelnianie dwuskładnikowe na GitHubie (najlepiej klucz sprzętowy lub aplikacja TOTP).
2. Złóż wniosek: <https://signpath.org/apply>. Opisz projekt jako „Portable SSH/Telnet/Serial terminal (Electron),
   MIT, built on GitHub Actions” i podaj link do repozytorium.
3. Po akceptacji, w SignPath:
   - dodaj Trusted Build System „GitHub.com” i połącz go z projektem `vytty`,
   - utwórz dwie *artifact configurations* o slugach `vytty-exe` i `vytty-portable` z plików
     [`.signpath/artifact-configuration-exe.xml`](../.signpath/artifact-configuration-exe.xml) i
     [`.signpath/artifact-configuration-portable.xml`](../.signpath/artifact-configuration-portable.xml),
   - utwórz signing policy (np. `release-signing`) i token API użytkownika z uprawnieniem *submitter*.
4. W repozytorium na GitHubie (*Settings → Secrets and variables → Actions*):
   - zmienne (*Variables*): `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` (`vytty`),
     `SIGNPATH_POLICY_SLUG` (`release-signing`),
   - sekret: `SIGNPATH_API_TOKEN`.
5. Od tej chwili workflow sam wysyła `Vytty.exe` (przed spakowaniem do zip i launchera), a potem launcher do
   podpisu. Czeka na Twoje zatwierdzenie w SignPath i wydaje podpisane pliki. Bez tych zmiennych buduje się
   jak dotąd, bez podpisu.

### 2. Microsoft Store (darmowe, Microsoft podpisuje paczkę)

Od września 2025 rejestracja indywidualnego dewelopera w Microsoft Store jest bezpłatna (weryfikacja dowodem
i selfie). Aplikacja wysłana jako **MSIX** jest podpisywana przez Microsoft, a aktualizacje dostarcza Sklep. Ma to
jednak swoje skutki:
- dotyczy tylko kopii ze Sklepu; pliki z GitHuba dalej nie są podpisane,
- wersja ze Sklepu nie jest „portable”: dane trafiają do `%LOCALAPPDATA%` (Vytty 0.10 już to obsługuje przez
  `process.windowsStore`), a aktualizuje ją Sklep,
- w firmach Sklep bywa zablokowany, choć Intune i winget (`--source msstore`) potrafią go wdrażać,
- potrzebne są: konto w Partner Center, rezerwacja nazwy, dane tożsamości paczki (Identity Name, Publisher) i cel
  `appx` w electron-builder. Mogę to dodać, gdy będziesz mieć konto.

### Czego za darmo się nie da

- **Certyfikat self-signed** jest darmowy, ale Microsoft mu **nie ufa**. Ma sens tylko wewnątrz jednej firmy, gdy
  IT rozgłosi certyfikat przez GPO lub Intune jako zaufanego wydawcę. Pipeline obsługuje plik `.pfx` (sekrety
  `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`).
- **Azure Artifact Signing** (dawniej Trusted Signing, ok. 9,99 USD/mies.) przyjmuje osoby prywatne tylko z USA
  i Kanady. Z Polski możesz z niego skorzystać jako organizacja (firma w UE). Pipeline jest na to przygotowany
  (zmienne `AZURE_SIGNING_*`).

### Tanio, z Twoim nazwiskiem w podpisie

**Certum Open Source Code Signing** (Asseco, polskie CA): ok. 49 € rocznie w chmurze (SimplySign) albo 69 € z kartą
i czytnikiem. Certyfikat jest wystawiany na Ciebie, dla niekomercyjnego open source. Wada: klucz w SimplySign wymaga
potwierdzania w aplikacji mobilnej, więc w CI trudniej to zautomatyzować. Najprościej podpisać lokalnie na Windows
(`signtool sign /fd sha256 /tr http://time.certum.pl /td sha256 /n "Twoje imię" plik.exe`) pliki pobrane z wydania
przed ich opublikowaniem albo sięgnąć po nieoficjalne narzędzia automatyzujące SimplySign.

## Co jeszcze możesz zrobić od razu (bez certyfikatu)

1. **Zgłoś plik jako fałszywy alarm** do Microsoftu: <https://www.microsoft.com/wdsi/filesubmission>, opcja
   *Software developer*. Microsoft oceni plik pod kątem Defendera i SmartScreen.
2. **Sprawdź plik na VirusTotal** i zobacz, które silniki go oznaczają (CrowdStrike Falcon też tam jest).
3. **Poproś dział bezpieczeństwa (SOC) o wyjątek**, podając:
   - nazwę wykrycia z konsoli Falcon (zwykle `Machine Learning`, „Win/malicious_confidence_…”),
   - skrót SHA-256 z `SHA256SUMS.txt` wydania,
   - dowód pochodzenia: `gh attestation verify Vytty-0.10.0-win-x64.zip --repo mtgmz14/vytty` (plik zbudował
     workflow tego repozytorium z publicznego kodu),
   - link do kodu źródłowego i do tego dokumentu.
   Wyjątek po skrócie trzeba odnawiać przy każdej wersji. Po podpisaniu SOC może dopuścić aplikację po certyfikacie.
4. **winget**: paczkę można zgłosić do `microsoft/winget-pkgs`. Manifesty generuje `scripts/winget-manifest.js`
   (opis w pliku). Zgłoszenie przechodzi automatyczne skanowanie Microsoftu, a w firmach winget bywa jedynym
   dopuszczonym kanałem instalacji.

## Jak działa weryfikacja aktualizacji (0.10.0)

1. Workflow wydania liczy `SHA256SUMS.txt` dla wszystkich plików. Listę podpisuje klucz Ed25519, którego część
   publiczna jest wkompilowana w aplikację (`src/main/update-keys.js`). Podpis powstaje na jeden z dwóch sposobów:
   - **klucz offline (domyślnie)**: bez sekretu `VYTTY_UPDATE_SIGNING_KEY` workflow zostawia wydanie jako szkic
     (*draft*), niewidoczny dla użytkowników i dla aktualizatora. Na komputerze z kluczem uruchamiasz
     `npm run release:sign -- v0.10.0`. Skrypt pobiera pliki szkicu i sprawdza ich sumy oraz atestację pochodzenia
     (zbudował je workflow wydania z tego tagu i z tego commita). Potem podpisuje listę, wysyła sam podpis
     (`SHA256SUMS.txt.sig`) i publikuje wydanie. Klucz prywatny nie opuszcza komputera.
   - **klucz w CI**: gdy dodasz sekret `VYTTY_UPDATE_SIGNING_KEY`, workflow podpisuje i publikuje wydanie sam.
2. Vytty pobiera najpierw listę i podpis, sprawdza podpis, a potem pobiera plik i liczy jego SHA-256. Instaluje go
   tylko wtedy, gdy wszystko się zgadza. Nazwa pliku zawiera wersję, więc starej, poprawnie podpisanej listy nie da
   się podsunąć jako nowszej wersji.
3. Bez podpisu, z błędnym podpisem albo z niezgodnym skrótem Vytty odmawia instalacji i proponuje stronę pobierania.

Klucz prywatny leży w `~/.config/vytty-release/update-signing-key.pem` (prawa tylko dla właściciela). Trzymaj jego
kopię w menedżerze haseł: bez klucza żadne nowe wydanie nie zainstaluje się samo w Vytty 0.10+. Przy kluczu offline
samo przejęcie konta GitHub nie wystarczy, żeby Vytty zainstalowało komuś podrzuconą wersję. Mimo to zabezpiecz
konto (2FA, najlepiej klucz sprzętowy) i włącz regułę (*ruleset*), która pozwala tworzyć tagi `v*` tylko Tobie.
