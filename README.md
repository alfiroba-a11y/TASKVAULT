# Task Vault

Standalone reward-platform prototype with an installable web app and HashPay M-Pesa STK prompts.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:4173` for the member dashboard or `http://localhost:4173/admin` for the operations preview. Local app demo data is stored in browser local storage. HashPay payment records are stored in MongoDB's `task_vault.payments` collection.

## Deploy on Coolify

Create an application from this folder/repository with Base Directory set to `task-vault`. Select the included `Dockerfile` build pack (or Nixpacks, which is configured by `nixpacks.toml`). Both install the production dependencies, including Mongoose. Expose container port `4173` and attach your HTTPS domain. The server binds to `0.0.0.0` and reads Coolify's `PORT` variable.

Set these values in the Coolify application's Environment Variables, then redeploy:

- `HASHPAY_API_KEY` — private HashPay API key
- `HASHPAY_ACCOUNT_ID` — your HashPay payment channel ID
- `HASHPAY_WEBHOOK_SECRET` — signing secret from HashPay
- `PUBLIC_BASE_URL` — public HTTPS origin, such as `https://taskvault.example.com`
- `MONGO_URI` — your shared MongoDB connection string
- `MONGO_DB_NAME=task_vault` — Task Vault's dedicated database name on that cluster

Configure the HashPay webhook at `https://your-domain/webhooks/hashpay`. The app can also send that URL on each STK request. The `/health` endpoint reports MongoDB and payment configuration status. Never put HashPay secrets in browser code or commit them to Git.

The Mongo connection explicitly selects the `task_vault` database (or the value of `MONGO_DB_NAME`) even if the shared connection URL names another default database. Task Vault's payment records use the `payments` collection inside that dedicated database; other apps using the same Mongo cluster and their own database names remain separate. If MongoDB or the Mongoose driver is unavailable, the web server still launches in degraded mode; payment requests return a clear unavailable response until MongoDB reconnects. `DATA_DIR` is not used because payment records are stored in MongoDB.

HashPay payment prompts use the HashBack STK endpoint; the API key and account ID stay on the server. The browser's response only says that HashPay accepted the prompt. Task Vault marks a payment paid only after the signed webhook matches its reference, amount, and account ID. See the [HashPay STK and webhook documentation](https://www.hashback.co.ke/documentation).

## App installation

Task Vault is a Progressive Web App. The **Download app** button opens the browser's native install prompt when the browser supports it. On iPhone, Safari requires the user to choose **Share → Add to Home Screen**. Browsers do not allow a website to silently install an app or download and run an APK. The service worker caches the app shell for offline dashboard loading; payment APIs still require a connection.

## Prototype limits

The admin path is not authenticated in this prototype. Member records and reward balances are sample browser data; withdrawals and reward claims are not real disbursements. HashPay STK prompts collect money to your configured channel, but successful prompts are not automatically converted into member reward balances. The admin deposit table remains sample UI data. Do not use this as a production wallet or payout system without server-side accounts, authenticated admin controls, a durable member/payment ledger, and a payout integration.

The signup camera flow demonstrates head-position prompts locally. It does not record, upload, or save camera frames or face templates, and it is not an identity verification service.

## Deployment recovery

If Coolify logs report `Cannot find package 'mongoose'`, the container is using an older image or the optional MongoDB driver could not install. The current server catches that condition and stays online in degraded mode; Mongo-backed payment requests remain disabled until the driver and database are available. Rebuild from the latest project files with the Base Directory set to the directory containing this `package.json`. The Dockerfile installs `curl` and defines a container health check at `/health` on port `4173`, with a 30-second startup grace period.
