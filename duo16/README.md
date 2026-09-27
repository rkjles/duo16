# Duo16

A Super NES emulator for Windows and Mac, built for playing online with a friend.

- **Online two-player** with no server: the host sends an invite code, the friend sends back a reply code, and you're connected.
- **Cheats online**: Game Genie and Pro Action Replay codes switch on at the same frame for both players.
- **Rewind online**: hold Backspace and both games rewind together, up to 3 minutes.
- **Fast-forward online**: 2× up to 10× speed, for both players at once.
- **Host controls**: the host decides whether the guest may use cheats, rewind, fast-forward, pause or reset.
- Battery saves, 4 save-state slots, keyboard and gamepad support, and `.zip` ROMs.
- A built-in two-player demo game (Paddle Duel) so you can test online play without a ROM.

---

## 1. Get the .exe and .app

The installers are built on GitHub's own Windows and Mac machines, so you don't need to install any developer tools. It's free and takes about 15 minutes the first time.

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Click **+** (top right) → **New repository**. Name it `duo16`. **Public** gives you unlimited free build time; private works too but uses your monthly free minutes (a Mac build uses roughly 100 of the 2,000 free minutes). Click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Drag in everything inside this `duo16` folder: `app`, `dev`, `.github`, `README.md` and `.gitignore`. Click **Commit changes**.
   - On a Mac, Finder hides the `.github` folder. Press **Cmd + Shift + .** in Finder to show hidden files before dragging.
   - If `.github` still doesn't upload: on the repository page choose **Add file → Create new file**, type `.github/workflows/build.yml` as the name, paste in the contents of that file from this folder, and commit.
4. Open the **Actions** tab. A build named **Build Duo16** starts on its own (if Actions asks you to enable workflows, click the green button, then choose **Build Duo16 → Run workflow**).
5. When both jobs show a green check (about 10 minutes), click the finished run and scroll to **Artifacts**:
   - **Duo16-Windows**: contains `Duo16-Setup-1.0.0.exe` (installer) and `Duo16-Portable-1.0.0.exe` (runs without installing).
   - **Duo16-Mac**: contains `Duo16-1.0.0-mac.dmg` and a `.zip` of `Duo16.app`. Works on both Apple Silicon and Intel Macs.

Want a permanent download page? Create a tag named `v1.0.0` (**Releases → Draft a new release → Choose a tag → type v1.0.0**) and publish it. The build attaches both downloads to that release.

### Or build on your own computer

Install [Node.js 20 LTS](https://nodejs.org), then in a terminal:

```
cd app
npm install
npm start            # run Duo16 right away without building
npm run dist:win     # on Windows: makes the .exe files in app/dist
npm run dist:mac     # on a Mac: makes the .dmg and .zip in app/dist/release
```

### First launch

The apps aren't signed with a paid Apple or Microsoft developer certificate, so each system warns you once.

- **Windows:** if you see "Windows protected your PC", click **More info → Run anyway**.
- **Mac:** right-click Duo16 → **Open** → **Open**. If macOS still refuses, go to **System Settings → Privacy & Security** and click **Open Anyway**. If it says the app "is damaged", open Terminal and run `xattr -cr /Applications/Duo16.app`, then open it again.

---

## 2. Play online

Both players need Duo16 (the same version) and **the same ROM file**. A copy with or without the old 512-byte copier header counts as the same game.

**Host (Player 1)**
1. Open your game, then go to the **Online** tab → **Host a game**.
2. Copy the invite code and send it to your friend (Discord, text, email…).
3. Paste the reply code your friend sends back, then click **Connect**.

**Guest (Player 2)**
1. **Online** tab → **Join a friend**, paste the invite code, click **Create reply code**.
2. Send the reply code back to the host.
3. When connected, open the same ROM file if Duo16 asks for it (it checks your recent games automatically).

The game starts for both players from the host's current moment, including the host's in-game save file. You can connect mid-game.

**How it stays in sync.** Both computers run the game and exchange only button presses. Each button press takes effect a few frames later on both machines ("input delay"), which Duo16 sets automatically from your ping. If the games ever drift apart, Duo16 notices within two seconds and copies the host's game over to repair it.

**If the connection fails.** Some networks (apartment or school Wi-Fi, phone hotspots) block direct connections. Two fixes:

- **Relay server (built in, nothing to install for your friend).** The host opens **Online → Relay server**. Choose **Metered Open Relay** and paste the credentials link from a free account at [metered.ca/tools/openrelay](https://www.metered.ca/tools/openrelay/) (20 GB free a month, which is hundreds of hours of Duo16), or choose **Enter a relay server myself** and type the address, username and password from a service like [expressturn.com](https://www.expressturn.com/). Click **Test relay**, then make a new invite code. The relay details travel inside the invite code, so your friend doesn't set anything up. Tick **Always use the relay** if the direct attempt keeps failing. When connected, **Route** shows **Direct** or **Relay**.
- **Tailscale.** Install [Tailscale](https://tailscale.com) on both computers, then use **Connect by IP address instead**. Allow Duo16 through the Windows firewall on the host.

**Things to know**
- The guest's in-game progress isn't saved to the guest's own save file during online play; it belongs to the host's game.
- Only the host can load a save state, and it loads for both players.
- If a player has a much slower connection, raise **Input delay** in Host settings to smooth out stutter.

---

## 3. Controls

| SNES | Keyboard | Gamepad |
|---|---|---|
| D-pad | Arrow keys | D-pad or left stick |
| B / A / Y / X | Z / X / A / S | Bottom / right / left / top face buttons |
| L / R | Q / W | Shoulder buttons |
| Start / Select | Enter / Right Shift | Start / Back |

| Action | Key |
|---|---|
| Rewind (hold) | Backspace. Controller: Select + L, or the left trigger on Xbox/PlayStation controllers. Goes back up to 3 minutes. Rewind speed is set in the Controls tab: Automatic (speeds up the longer you hold) or a fixed 2× to 10×. |
| Pause | P |
| Save / load state | F5 / F7 (choose slot with 1–4) |
| Fast-forward | Hold Tab, or click the ⏩ button to switch it on and off. Controller: hold Select + R, or the right trigger on Xbox/PlayStation controllers. Choose 2× to 10× in the Controls tab. |

Change any of these in the **Controls** tab. In offline play, a second gamepad controls Player 2.

**USB controllers.** Plug the controller in and press any button on it (computers only report a controller after a button press). Then open the **Controls** tab:
1. Under **Your controller**, pick it from the list (or leave it on Automatic).
2. Press buttons and watch the row of button names light up to check they're right.
3. If a button is wrong, click it in the list, then press the button you want on the controller. Duo16 remembers the layout for that controller.

The **Controls** tab shows a diagram of the SNES buttons that lights up as you press them, plus a table of which Xbox and PlayStation buttons match SNES A, B, X and Y.

You can also set rewind and fast-forward to any spare controller button there. While Select + L or Select + R is held, the game doesn't see those buttons; switch the shortcuts off in the Controls tab if a game needs that combination.

Xbox and PlayStation controllers work without setup. Other USB controllers, including SNES-style pads, get a best-guess layout that you can fix in a few clicks. During online play, each player sets up their own controller on their own computer.

## 4. Cheats

**Find cheats online.** Open the **Cheats** tab while a game is running. Duo16 identifies your exact ROM and lists the cheats for it from the free [libretro cheat database](https://github.com/libretro/libretro-database). Click **Add** next to any cheat you want. If the game version isn't right, pick another from **Game version** or search by name. Cheats you've looked up before still work offline.

**Enter a code yourself.** Type a code and a short description:
- **Game Genie**: `XXXX-XXXX`, for example `C9C8-6FAD`
- **Pro Action Replay**: 8 hex digits, for example `7E0DBE05`, or `7E0DBE:05`

Duo16 detects the type (you can also choose it). A cheat can hold several codes joined with `+`, like `7E0F3109+7E0F3209`.

**Editing a cheat.** Click **Edit** next to a cheat in your list to change its code or description, then click **Save** (or press Enter). Press Escape or click **Cancel** to leave it as it was. Online, the edit reaches both players at the same moment.

**Turning cheats off.** Untick a cheat's checkbox to switch just that one off, or click × to remove it. The **Cheats on / Cheats off** switch above your list turns every cheat off at once and keeps your list for later. Online, both work for both players at the same moment. A cheat that set a number (like lives) leaves it where it was when you switch it off; the game counts normally from there. Cheats are saved per game. Online, any change takes effect at the same frame for both players, and the host can turn guest cheats off.

---

## 5. Compatibility

Duo16's emulator was written from scratch for this project. It covers the Super NES main processor, graphics (all background modes including Mode 7, sprites, windows, color blending, mosaic), the sound processor with echo, DMA/HDMA, and LoROM/HiROM/ExHiROM cartridges with battery saves.

It was tested with test programs and the built-in demo, **not with commercial games**, so expect some games to show glitches or not boot. Known limits:

- **Enhancement chips aren't supported yet.** Games that need them won't run: Super FX (Star Fox, Yoshi's Island, Stunt Race FX), SA-1 (Super Mario RPG, Kirby Super Star, Kirby's Dream Land 3), DSP-1 (Super Mario Kart, Pilotwings), and a few others. Duo16 warns you when you open one.
- **Two players only.** Games that need the Super Multitap for 3–5 players (Super Bomberman's 4-player mode, Secret of Mana's 3-player mode) play with two.
- High-resolution modes 5 and 6 (used by a handful of games for text) are shown at half horizontal resolution.

Games without special chips that are popular for two players include Street Fighter II Turbo, Mortal Kombat II, NBA Jam, Contra III, Teenage Mutant Ninja Turtles IV, Super Mario World, Donkey Kong Country and Super Bomberman (2 players).

Use ROM files you have made from cartridges you own.

## 6. Where files are kept

Saves, save states, cheats and settings live in your user data folder (**File → Open Saves Folder**):
- Windows: `%APPDATA%\Duo16`
- Mac: `~/Library/Application Support/Duo16`

## 7. For developers

- `app/` is the Electron app. The emulator core is in `app/renderer/emu/`: `cpu.js` (65816), `ppu.js`, `apu.js` (SPC700 + DSP), `snes.js` (bus, DMA, timing), `state.js` (save states), `cheats.js`, `machine.js` (deterministic game unit) and `session.js` (lockstep networking).
- `dev/` has the tests and tools: a 65816 assembler, the demo game source (`demo.asm`), a CPU test ROM, a network simulator that checks two players stay in sync under lag and packet loss, and a two-window test of the real app in Chromium (`ui_test.js`, needs Playwright).
- Run `cd dev && npm test`.
