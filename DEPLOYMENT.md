# Deployment Guide - RAG LangChain Agent

This guide covers deploying the RAG LangChain Agent to various cloud platforms.

## Prerequisites

1. **Environment Variables**: You need to set `OPENAI_API_KEY` in your deployment platform
2. **GitHub Repository**: Your code should be in a GitHub repository (recommended)

## Quick Deploy Options

### 🚀 Option 1: Render (Recommended - Easiest)

**Why Render?** Free tier available, easy setup, supports Docker, automatic deployments from GitHub.

#### Steps:

1. **Sign up** at [render.com](https://render.com)

2. **Create New Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select this repository

3. **Configure Service**:
   - **Name**: `rag-langchain-agent` (or any name)
   - **Environment**: `Node`
   - **Build Command**: `npm ci --legacy-peer-deps && npm run build`
   - **Start Command**: `npm run start:prod`
   - **Plan**: Free (or upgrade for production)

4. **Set Environment Variables**:
   - Click "Environment" tab
   - Add: `OPENAI_API_KEY` = `your-api-key-here`
   - Add: `NODE_ENV` = `production`

5. **Deploy**:
   - Click "Create Web Service"
   - Wait for build to complete (~2-3 minutes)
   - Your app will be live at `https://your-app-name.onrender.com`

**Note**: Free tier services spin down after 15 minutes of inactivity. First request after spin-down may take ~30 seconds.

---

### 🚂 Option 2: Railway

**Why Railway?** Simple deployment, good free tier, automatic HTTPS.

#### Steps:

1. **Sign up** at [railway.app](https://railway.app)

2. **Create New Project**:
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your repository

3. **Configure**:
   - Railway will auto-detect the Dockerfile
   - Or use the `railway.json` config file

4. **Set Environment Variables**:
   - Go to "Variables" tab
   - Add: `OPENAI_API_KEY` = `your-api-key-here`

5. **Deploy**:
   - Railway will automatically build and deploy
   - Get your live URL from the "Settings" → "Domains"

---

### ⚡ Option 3: Vercel (Serverless)

**Why Vercel?** Great for serverless, but requires some modifications for long-running processes.

**Note**: Vercel is serverless and has execution time limits. For this RAG app with embeddings, **Render or Railway are better choices**.

If you still want to use Vercel:

1. **Install Vercel CLI**: `npm i -g vercel`
2. **Deploy**: `vercel`
3. **Set Environment Variables** in Vercel dashboard

---

### 🐳 Option 4: Docker (Any Platform)

You can deploy the Docker image to:
- **DigitalOcean App Platform**
- **AWS ECS/Fargate**
- **Google Cloud Run**
- **Azure Container Apps**
- **Fly.io**
- **Any VPS with Docker**

#### Steps:

1. **Build the image**:
   ```bash
   docker build -t rag-agent:latest .
   ```

2. **Test locally**:
   ```bash
   docker run -p 3000:3000 -e OPENAI_API_KEY=your-key rag-agent:latest
   ```

3. **Push to registry** (Docker Hub example):
   ```bash
   docker tag rag-agent:latest yourusername/rag-agent:latest
   docker push yourusername/rag-agent:latest
   ```

4. **Deploy to your platform** using the image

---

## Environment Variables

Required environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | Your OpenAI API key | ✅ Yes |
| `PORT` | Server port (default: 3000) | ❌ No |
| `NODE_ENV` | Set to `production` | ❌ No |

---

## Build & Test Locally Before Deploying

```bash
# Install dependencies
npm ci

# Build TypeScript
npm run build

# Test production build
npm run start:prod
```

Visit `http://localhost:3000` to verify everything works.

---

## Troubleshooting

### Issue: "Cannot find module" errors
**Solution**: Make sure `npm run build` completes successfully and `dist/` folder contains compiled files.

### Issue: "OPENAI_API_KEY is not defined"
**Solution**: Set the environment variable in your deployment platform's dashboard.

### Issue: App times out or crashes
**Solution**: 
- Check memory limits (embeddings can be memory-intensive)
- Upgrade to a plan with more resources
- Check logs for specific error messages

### Issue: Slow first request
**Solution**: This is normal - the HuggingFace model needs to download on first use. Subsequent requests will be faster.

---

## Production Recommendations

1. **Use a paid plan** for production (better performance, no spin-down)
2. **Set up monitoring** (Render/Railway have built-in logs)
3. **Use a CDN** for static assets (optional)
4. **Set up error tracking** (Sentry, etc.)
5. **Rotate API keys** regularly
6. **Set up rate limiting** if exposing publicly

---

## Cost Estimates

- **Render Free**: $0/month (with limitations)
- **Render Starter**: $7/month
- **Railway Hobby**: $5/month
- **Vercel Hobby**: $0/month (with limits)

---

## Need Help?

- Check platform-specific documentation
- Review logs in your deployment dashboard
- Ensure all environment variables are set correctly
- Verify the build completes successfully

