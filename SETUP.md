# Pulse — setup guide

Pulse is a web app (PWA). It's hosted free on GitHub Pages and installs to the iPhone
home screen with its own icon, full-screen, no browser bars. It works offline.

## 1. Put it online (GitHub Pages, free)

1. On github.com, click **New repository**. Name it `pulse`, set it to **Public**, and create it.
2. Push this folder to it:
   ```
   git remote add origin https://github.com/<your-username>/pulse.git
   git push -u origin main
   ```
   (Or on the repo page: **Add file → Upload files**, then drag in everything in this folder.)
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   then pick **main** and **/ (root)**, and click **Save**.
4. After a minute the app is live at `https://<your-username>.github.io/pulse/`.

## 2. Install it on an iPhone

1. Open the link in **Safari** (it has to be Safari on iPhone).
2. Tap **Share** (the square with the arrow) → **Add to Home Screen** → **Add**.
3. The purple basketball icon shows up on the home screen.

## 3. Logins and cloud backup (optional, about 10 minutes, free)

Without this, each phone keeps its own data, which already works fine for separate people on
separate phones. The catch: if someone deletes the app from the home screen, iOS deletes its
data. So either use **Me → Download backup** now and then, or turn on accounts:

1. Make a free project at **supabase.com** (any name and region).
2. Open **SQL Editor**, paste in everything from `supabase.sql`, and click **Run**.
3. Under **Authentication → Sign In / Providers → Email**, you can turn off **Confirm email** so
   friends can sign up instantly. If you leave it on, they confirm by email first.
4. Under **Authentication → URL Configuration**, set **Site URL** to your GitHub Pages link.
5. Under **Project Settings → API**, copy the **Project URL** and the **anon public** key
   into `config.js`, then push again.

Now everyone who opens the link gets a sign-in screen and their own account, with data synced
across devices. The anon key is meant to be public. Row-level security keeps each person's
data private.

## Updating the app

Edit the files and push. Phones pick up the new version the next time the app is opened
with internet.

## Regenerating the icon

`python tools/make_icons.py` (needs Pillow).
