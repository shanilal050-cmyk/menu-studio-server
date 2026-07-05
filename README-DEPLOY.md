# Menu Studio — Import Server (deploy in ~15 min, free)

## 1) Free Gemini key lo (no credit card)
1. https://aistudio.google.com/apikey kholo, Google login karo.
2. "Create API key" → key copy kar lo. (Free tier: daily limit ke saath, roz reset.)

## 2) Render pe deploy (free)
1. https://render.com pe signup (GitHub se easiest).
2. Is `server/` folder ko ek GitHub repo mein daalo (ya Render ka "Deploy from Git" use karo).
3. Render dashboard → "New +" → "Web Service" → apna repo chuno.
4. Settings:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
5. "Environment" tab → Add:
   - `GEMINI_API_KEY` = (step 1 wali key)
6. Deploy. URL milega jaise: `https://menu-studio-xyz.onrender.com`
7. Test: browser mein `https://<url>/healthz` kholo → `{"ok":true,...}` dikhna chahiye.

## 3) Team ko sirf ye batao
Menu Studio (HTML) mein → Import Menu → "Team server URL" mein wo URL paste (ek baar, device pe save ho jata hai).

## Notes
- Key sirf server env mein hai; browser/HTML mein kabhi nahi jaati.
- Render free tier 15 min idle ke baad so jata hai — pehli request pe ~30s lagta hai (cold start). Normal hai.
- Gemini free quota khatam ho toh error milega "AI quota exhausted" — agle din reset, ya dusri free key laga do.
