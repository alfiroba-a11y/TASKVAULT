# Task Vault

Task Vault member platform with MongoDB-backed accounts, sponsored tasks and videos, referral rewards, daily check-ins, withdrawal scheduling, and HashPay M-Pesa STK prompts.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:4173` for the sign-up and member experience or `http://localhost:4173/admin` for the private operations panel. Member accounts, videos, withdrawal requests, and HashPay payment records are stored in MongoDB's `task_vault` database.

## Deploy on Coolify

Create an application from this folder/repository with Base Directory set to `task-vault`. Select the included `Dockerfile` build pack (or Nixpacks, which is configured by `nixpacks.toml`). Both install the production dependencies, including Mongoose. Expose container port `4173` and attach your HTTPS domain. The server binds to `0.0.0.0` and reads Coolify's `PORT` variable.

Set these values in the Coolify application's Environment Variables, then redeploy:

- `HASHPAY_API_KEY` — private HashPay API key
- `HASHPAY_ACCOUNT_ID` — your HashPay payment channel ID
- `HASHPAY_WEBHOOK_SECRET` — signing secret from HashPay
- `PUBLIC_BASE_URL` — public HTTPS origin, such as `https://taskvault.example.com`
- `MONGO_URI` — your shared MongoDB connection string
- `MONGO_DB_NAME=task_vault` — Task Vault's dedicated database name on that cluster
- `SESSION_SECRET` — long random secret used to sign member/admin session cookies
- `ADMIN_PASSWORD` — strong password for the private `/admin` panel

Set a long random value for `SESSION_SECRET` and your chosen private password for `ADMIN_PASSWORD`. Keep both locked as secrets in Coolify.

Configure the HashPay webhook at `https://your-domain/webhooks/hashpay`. The app can also send that URL on each STK request. The `/health` endpoint reports MongoDB and payment configuration status. Never put HashPay secrets in browser code or commit them to Git.

The Mongo connection explicitly selects the `task_vault` database (or the value of `MONGO_DB_NAME`) even if the shared connection URL names another default database. Task Vault's payment records use the `payments` collection inside that dedicated database; other apps using the same Mongo cluster and their own database names remain separate. If MongoDB or the Mongoose driver is unavailable, the web server still launches in degraded mode; payment requests return a clear unavailable response until MongoDB reconnects. `DATA_DIR` is not used because payment records are stored in MongoDB.

HashPay payment prompts use the HashBack STK endpoint; the API key and account ID stay on the server. The browser's response only says that HashPay accepted the prompt. Task Vault marks a payment paid only after the signed webhook matches its reference, amount, and account ID. See the [HashPay STK and webhook documentation](https://www.hashback.co.ke/documentation).

## App installation

Task Vault is a Progressive Web App. The **Download app** button opens the browser's native install prompt when the browser supports it. On iPhone, Safari requires the user to choose **Share → Add to Home Screen**. Browsers do not allow a website to silently install an app or download and run an APK. The service worker caches the app shell for offline dashboard loading; payment APIs still require a connection.

## Prototype limits

Member accounts, referral credits, task completion, video reward claims, and withdrawal requests are stored in MongoDB. New visitors can sign up for free. After sign-in, the dashboard requires a one-time live face scan before tasks and earning actions are unlocked. The hidden `/admin` route requires `ADMIN_PASSWORD`. The app contains 70 sample sponsored tasks; replace them with real advertiser offers and verify completions with the relevant offer provider before paying real rewards. Video upload uses direct HTTPS MP4/WebM URLs, with up to five quiz questions per video. A video pays once after a full watch is detected; the quiz bonus pays once after every answer is correct. Withdrawals stay locked until 26 February 2027; after that date, admin approval is still required and no automatic payout provider is connected. HashPay STK prompts collect money to your configured channel but do not increase member rewards.

The dashboard face scan uses MediaPipe Face Landmarker in the browser to find a face and check that it moves in response to left, right, up, and down prompts. Raw camera frames and face landmarks stay on the device and are not uploaded or stored. On HTTPS, the browser uses a live camera preview. On HTTP, where browsers block live camera APIs, the app falls back to native camera photo capture for each scan prompt; browser support for the `capture` input is limited, so some browsers may show a file picker instead. The browser loads the vision runtime from jsDelivr and the model from Google Storage, so clients need network access to those hosts during the scan. This is a basic liveness check, not identity/KYC verification or reliable spoof detection; use a dedicated server-side liveness provider if stronger anti-fraud assurance is required. HTTP mode also requires session cookies without the `Secure` attribute, so passwords and sessions can be intercepted on an unencrypted connection; HTTPS remains strongly recommended for real accounts.

## Deployment recovery

If Coolify logs report `Cannot find package 'mongoose'`, the container is using an older image or the optional MongoDB driver could not install. The current server catches that condition and stays online in degraded mode; Mongo-backed payment requests remain disabled until the driver and database are available. Rebuild from the latest project files with the Base Directory set to the directory containing this `package.json`. The Dockerfile installs `curl` and defines a container health check at `/health` on port `4173`, with a 30-second startup grace period.
