# Try the CMMS on your Windows PC

This guide runs the real CMMS on your own Windows PC or laptop, with 90 days of demo data. It takes about 15 minutes; most of that is downloading. Nothing here changes anything on GitHub or on other computers.

## What you need

- A Windows 10 or 11 PC or laptop
- An internet connection for the first run
- About 500 MB of free disk space

## Step 1: Install Node.js (one time only)

Node.js is the free engine the CMMS runs on.

1. Go to **https://nodejs.org**.
2. Click the big **LTS** download button.
3. Open the downloaded file and click **Next** through the installer, keeping all the default options. If it offers "Automatically install the necessary tools", leave it **unticked**.
4. When it finishes, **restart the PC**. This makes sure Windows can find Node.js.

## Step 2: Download the CMMS from GitHub

1. Open **https://github.com/lctandoc10-sudo/housing-dashboard-data**.
2. Click the green **<> Code** button, then **Download ZIP**.
3. Open your **Downloads** folder, right-click **housing-dashboard-data-main.zip**, and choose **Extract All…**
4. Extract it to a simple location, for example `C:\PrecastCMMS`.

You now have a folder like `C:\PrecastCMMS\housing-dashboard-data-main\cmms`.

> If your repository is private, you need to be signed in to GitHub to download it. Download ZIP still works.

## Step 3: Start it

1. Open the folder `cmms\deploy\windows`.
2. Double-click **start-demo.bat**.
3. If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**. This appears because the file was downloaded from the internet.
4. A black window opens. On the **first run** it installs components and creates the demo data. This takes 2–5 minutes, so let it finish.
5. If **Windows Firewall** asks about Node.js:
   - To try it on this PC only, click **Cancel**.
   - To also try it from your phone (Step 5), tick **Private networks** and click **Allow access**.
6. Your browser opens **http://localhost:3000** and shows the sign-in page.

**Keep the black window open while you use the app.** Closing it stops the CMMS.

## Step 4: Sign in and explore

| Username | Password | What you see |
|---|---|---|
| `manager` | `Demo1234` | Everything: dashboard, approvals, costs, reports |
| `sup.factory` | `Demo1234` | Factory supervisor: assign, verify and close jobs |
| `tech.jun` | `Demo1234` | Technician: "My jobs", checklist, labor, findings |
| `prod.cpf` | `Demo1234` | Production user: report breakdowns, availability |
| `admin` | `Admin12345` | Administrator. You must set a new password first. Then manage users, passwords, sites and settings. |

Things to try:

1. **As `prod.cpf`:** click **⚠ Report breakdown**, pick a forklift, choose High and "Stopped", and submit.
2. **As `sup.factory`:** open that work order and assign `Jun Santos`.
3. **As `tech.jun`:** open **My jobs**, start the job, record labor and the repair details, mark it ready for testing, then submit.
4. **As `sup.factory`:** verify and close it. The forklift returns to "Available" on the availability board.
5. **As `admin`:** create a user under **Users & passwords**, then sign in as that user. You'll be asked to change the password.
6. **As `manager`:** open the **Dashboard** and select a KPI to see its formula and the records behind it. Then try **Reports & exports**, which download to Excel.

## Step 5 (optional): Open it on your phone

The phone must be on the **same Wi-Fi** as the PC, and you must have allowed the firewall in Step 3.

1. On the PC, press **Windows key + R**, type `cmd` and press Enter.
2. Type `ipconfig` and press Enter.
3. Find **IPv4 Address** under your Wi-Fi adapter, for example `192.168.1.25`.
4. On the phone's browser, open `http://192.168.1.25:3000`, using your own address.

Some features work only when the app runs on a proper server with HTTPS: in-app QR scanning and the phone camera prompt. On this test setup, scan QR labels with the phone's normal camera app instead, or type the equipment ID.

## Everyday use

| To | Do this |
|---|---|
| Start again later | Double-click `start-demo.bat`. It starts in a few seconds after the first run. |
| Stop | Close the black window. |
| Start over with fresh demo data | Close the app, double-click `reset-demo.bat`, then `start-demo.bat`. |
| Make a backup of the data | Close the app, open `cmd` in the `cmms` folder and run `set CMMS_DB=data\demo.db` then `npm run backup`. |

Demo data is stored in `cmms\data\demo.db`. It's for trying things out only; your real equipment goes into a separate, clean database during the pilot setup.

## If something goes wrong

| Message | Fix |
|---|---|
| "Node.js is not installed" | Install it (Step 1) and **restart the PC**. |
| "Installation failed" during the first run | Check the internet connection. On a company network, a proxy may block downloads; ask IT, or try on a home or mobile hotspot connection. |
| Browser shows "This site can't be reached" | Wait a few seconds and refresh. The app may still be starting. Make sure the black window is still open. |
| "EADDRINUSE" / port 3000 already in use | Another program uses port 3000. Close any other open CMMS window, or restart the PC. |
| Forgot the admin password | Close the app, open `cmd` in the `cmms` folder and run `set CMMS_DB=data\demo.db`, then `set CMMS_NEW_PASSWORD=NewPass123`, then `node server\cli.js reset-password admin`. |
| Anything else | Copy the text from the black window and send it to me. |

## After you have tried it

When you're happy with how it works, the next step is the **pilot on a company server or office PC**. The CMMS runs all the time as a Windows service, phones on the site Wi-Fi connect to it, it takes automatic nightly backups, and it starts with a clean database for your real equipment and staff.
