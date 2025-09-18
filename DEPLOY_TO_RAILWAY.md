# Railway Deployment Instructions

## Files to Upload to GitHub

Upload these files from the `server/` directory to your GitHub repo:

1. `src/index.js` - Main server file
2. `package.json` - Dependencies and scripts
3. `package-lock.json` - Locked dependency versions
4. `Procfile` - Railway process definition
5. `railway.toml` - Railway configuration (prevents server starting during build)
6. `.railwayignore` - Files to ignore during deployment
7. `.gitignore` - Git ignore rules
8. `SECURITY.md` - Security documentation
9. `railway.json` - Railway configuration

## Railway Configuration

1. Connect your GitHub repo to Railway
2. In Railway service settings:
   - **Root Directory**: `/` (leave empty)
   - **Build Command**: leave empty 
   - **Start Command**: leave empty (Procfile handles this)

## Environment Variables

Set these in Railway:
- `NODE_ENV=production`
- `PORT=8080` (Railway sets this automatically)
- `DATABASE_URL` (optional, for PostgreSQL)

## Deploy

After uploading files and configuring Railway, click "Deploy" in Railway dashboard.

The server should start with: `Server listening at http://0.0.0.0:8080`
