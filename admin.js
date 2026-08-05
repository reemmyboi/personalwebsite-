// ===== CONFIG =====
const REPO_OWNER = 'reemmyboi';
const REPO_NAME = 'personalwebsite-';
const API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const TOKEN_KEY = 'gh_pat';
const ANCHOR_START = '<!-- ADMIN:BLOG_LIST_START -->';
const ANCHOR_END = '<!-- ADMIN:BLOG_LIST_END -->';
const SITE_BASE_URL = 'https://reemmyboi.github.io/personalwebsite-/';

// ===== UTF-8-SAFE BASE64 =====
// Plain btoa/atob operate on UTF-16 code units, not bytes, and break on
// any character outside Latin1 -- this site uses emoji throughout.
function utf8ToBase64(str){
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
}

function base64ToUtf8(b64){
    // GitHub wraps content in newlines every ~60 chars; atob throws on those.
    const binary = atob(b64.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

// ===== ESCAPING =====
function escapeHtml(str){
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(str){
    return escapeHtml(str).replace(/"/g, '&quot;');
}

// ===== SLUGS =====
function slugify(str){
    return String(str)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || 'post';
}

function uniqueSlug(baseSlug, existingSlugs){
    let slug = baseSlug;
    let n = 2;
    while(existingSlugs.includes(slug)){
        slug = `${baseSlug}-${n}`;
        n++;
    }
    return slug;
}

// ===== GITHUB API =====
function getToken(){
    return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(token){
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json'
    };
}

async function apiError(res){
    if(res.status === 401) return new Error('Token invalid or expired. Please log in again.');
    if(res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'){
        const resetAt = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
        return new Error(`GitHub API rate limit hit. Resets at ${resetAt.toLocaleTimeString()}.`);
    }
    if(res.status === 403) return new Error('Token lacks required permission (Contents: Read and write) for this repo.');
    if(res.status === 404) return new Error('File or repo not found -- check the token\'s repository access.');
    if(res.status === 409 || res.status === 422) return new Error('CONFLICT');
    const body = await res.text().catch(() => '');
    return new Error(`GitHub API error ${res.status}: ${body.slice(0, 200)}`);
}

async function apiRequest(path, options = {}){
    const token = getToken();
    if(!token){
        handleLogout();
        throw new Error('Not logged in.');
    }

    const res = await fetch(`${API}${path}`, {
        ...options,
        headers: { ...authHeaders(token), ...(options.headers || {}) }
    });

    if(res.status === 401){
        localStorage.removeItem(TOKEN_KEY);
        alert('Your session token is no longer valid. Please log in again.');
        location.reload();
        throw new Error('Unauthorized');
    }
    if(!res.ok) throw await apiError(res);
    return res;
}

async function validateToken(token){
    const res = await fetch(`${API}/contents/index.html?ref=main`, { headers: authHeaders(token) });
    if(res.status === 401) throw new Error('Invalid or expired token.');
    if(res.status === 403) throw new Error('Token valid but lacks Contents read/write permission for this repo.');
    if(res.status === 404) throw new Error('Token valid but cannot see this repo -- check its repository access scope.');
    if(!res.ok) throw new Error(`Unexpected error (${res.status}) validating token.`);
    return true;
}

async function fetchIndexHtml(){
    const res = await apiRequest('/contents/index.html?ref=main');
    const json = await res.json();
    return { html: base64ToUtf8(json.content), sha: json.sha };
}

async function putIndexHtml(newHtml, sha, message){
    const res = await apiRequest('/contents/index.html', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message,
            content: utf8ToBase64(newHtml),
            sha,
            branch: 'main'
        })
    });
    return res.json();
}

// ===== IMAGE UPLOAD =====
async function resizeImageToBlob(file, { maxDim = 1600, quality = 0.82 } = {}){
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function blobToBase64(blob){
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// GitHub's Contents API has a practical ~1MB ceiling per file, and base64
// inflates size by ~33% -- so the real binary budget is closer to ~700KB.
async function uploadImage(file, slugHint){
    let blob = await resizeImageToBlob(file, { maxDim: 1600, quality: 0.82 });
    if(blob.size > 700000){
        blob = await resizeImageToBlob(file, { maxDim: 1200, quality: 0.6 });
    }
    if(blob.size > 700000){
        throw new Error('This image is too large even after compression. Try a smaller or simpler image.');
    }

    const b64 = await blobToBase64(blob);
    const filename = `${slugHint}-${Date.now()}.jpg`;
    const path = `photos/${filename}`;

    await apiRequest(`/contents/${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: `Upload blog image: ${filename}`,
            content: b64,
            branch: 'main'
        })
    });

    return path;
}

// ===== BLOG-PREVIEW MARKUP =====
function buildBlogPreviewHtml(post){
    // post = { slug, title, summary, tags: [...], date, previewImgPath, headerImgPath, bodyHtml, parentSlug }
    const tagsAttr = post.tags.join(' ');
    const tagsDisplay = post.tags.map(t => '#' + t).join(' ');
    // header image is optional -- reuse the preview image if none was given
    const headerImgPath = post.headerImgPath || post.previewImgPath;
    // parentSlug is optional -- marks this post as an episode nested under a series post
    const parentAttr = post.parentSlug ? ` data-parent="${escapeAttr(post.parentSlug)}"` : '';
    // the visible card is a real link straight to the post's standalone
    // page (see buildStandalonePostHtml) -- .full-content sits as a
    // sibling, not nested inside the <a>, since post bodies can contain
    // their own links and HTML doesn't allow anchors inside anchors
    return `<div class="blog-preview" data-slug="${escapeAttr(post.slug)}" data-date="${escapeAttr(post.date)}" data-tags="${escapeAttr(tagsAttr)}"${parentAttr}>
                <a class="blog-preview-link" href="blog/${escapeAttr(post.slug)}/">
                    <img src="${escapeAttr(post.previewImgPath)}" class="blog-img" alt="${escapeAttr(post.title)}">
                    <h2>${escapeHtml(post.title)}</h2>
                    <p class="summary">${escapeHtml(post.summary)}</p>
                    <p class="tags">${escapeHtml(tagsDisplay)}</p>
                </a>

                <div class="full-content">
                    <h1>${escapeHtml(post.title)}</h1>
                    <img src="${escapeAttr(headerImgPath)}" class="blog-img-full" alt="${escapeAttr(post.title)}">
                    ${post.bodyHtml}
                </div>
            </div>`;
}

// ===== STANDALONE PER-POST PAGES (for search engine indexing) =====
// The SPA at index.html holds every post's content in one document behind
// JS-driven view state, which search engines have no reliable, unique URL
// to point at per post. These standalone pages give each post (and each
// episode) its own real, crawlable URL at blog/<slug>/index.html, with the
// actual content sitting directly in the page rather than behind JS state.
function toRootRelative(path){
    return '../../' + path;
}

// "Similar Blogs" -- other posts sharing at least one tag, with sibling
// episodes (same parent series) weighted well above pure tag overlap so
// they always surface first when they exist. Mirrors the SPA's old
// renderRelatedPosts() scoring, just computed statically at publish time
// instead of client-side, since standalone pages carry no JS of their own.
function buildSimilarBlogsSection(post, allPosts){
    const ownEpisodeSlugs = allPosts.filter(p => p.parentSlug === post.slug).map(p => p.slug);

    const scored = allPosts
        .filter(p => {
            if(p.slug === post.slug) return false; // never itself
            if(p.slug === post.parentSlug) return false; // already shown via the "Part of" link
            if(ownEpisodeSlugs.includes(p.slug)) return false; // already shown in this post's own Episode row
            return true;
        })
        .map(p => {
            const shared = p.tags.filter(t => post.tags.includes(t)).length;
            const sameParent = !!post.parentSlug && p.parentSlug === post.parentSlug;
            const score = shared + (sameParent ? 10 : 0);
            return { post: p, score };
        })
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score || new Date(b.post.date) - new Date(a.post.date))
        .slice(0, 3);

    if(scored.length === 0) return '';

    const cards = scored.map(({ post: p }) => `
                <a class="related-post-card" href="../${escapeAttr(p.slug)}/">
                    <img src="${escapeAttr(toRootRelative(p.previewImgPath))}" class="related-post-img" alt="${escapeAttr(p.title)}">
                    <h3>${escapeHtml(p.title)}</h3>
                    <p>${escapeHtml(p.summary)}</p>
                </a>`).join('');

    return `
            <div class="related-posts">
                <h2>Similar Blogs</h2>
                <div class="related-posts-list">${cards}
                </div>
            </div>`;
}

function buildStandalonePostHtml(post, allPosts){
    const episodes = allPosts
        .filter(p => p.parentSlug === post.slug)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    const parent = post.parentSlug ? allPosts.find(p => p.slug === post.parentSlug) : null;
    const headerImgPath = post.headerImgPath || post.previewImgPath;
    const description = escapeAttr((post.summary || post.title).slice(0, 300));

    let bodySection;
    if(episodes.length > 0){
        // category page: compact overview + links to each episode's own
        // standalone page, mirroring the SPA's category view
        const episodeLinks = episodes.map((ep, i) => `
                <a class="episode-card" href="../${escapeAttr(ep.slug)}/">
                    <img src="${escapeAttr(toRootRelative(ep.previewImgPath))}" class="episode-img" alt="${escapeAttr(ep.title)}">
                    <span class="episode-number">#${i + 1}</span>
                    <h3>${escapeHtml(ep.title)}</h3>
                </a>`).join('');
        // a category post can also carry its own real write-up (not just be
        // a bare hub) -- show it below the episode list rather than making
        // it unreachable now that there's no SPA "read the full write-up"
        // toggle to click through to
        const rootRelativeBody = post.bodyHtml.replace(/src="photos\//g, 'src="../../photos/');
        bodySection = `
            <div class="category-overview">
                <img src="${escapeAttr(toRootRelative(post.previewImgPath))}" class="category-overview-img" alt="${escapeAttr(post.title)}">
                <h1>${escapeHtml(post.title)}</h1>
                <p class="category-overview-summary">${escapeHtml(post.summary)}</p>
            </div>
            <div class="blog-episodes">
                <h2>Episode</h2>
                <div class="episode-list">${episodeLinks}
                </div>
            </div>
            ${rootRelativeBody}`;
    }else{
        const parentLink = parent
            ? `<p class="episode-parent-link">Part of <a href="../${escapeAttr(parent.slug)}/">${escapeHtml(parent.title)}</a></p>`
            : '';
        // inline images in the body are always stored as "photos/..." (see
        // uploadImage()) -- rewrite them to be root-relative from two
        // directories deep, same as the fixed header image path below
        const rootRelativeBody = post.bodyHtml.replace(/src="photos\//g, 'src="../../photos/');
        bodySection = `
            ${parentLink}
            <h1>${escapeHtml(post.title)}</h1>
            <img src="${escapeAttr(toRootRelative(headerImgPath))}" class="blog-img-full" alt="${escapeAttr(post.title)}">
            ${rootRelativeBody}`;
    }

    bodySection += buildSimilarBlogsSection(post, allPosts);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(post.title)} — REEMMY</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${SITE_BASE_URL}blog/${escapeAttr(post.slug)}/">
<meta property="og:title" content="${escapeAttr(post.title)}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${SITE_BASE_URL}${escapeAttr(post.previewImgPath)}">
<meta property="og:type" content="article">
<link rel="icon" type="image/png" sizes="32x32" href="../../photos/favicon-32x32.png">
<link rel="stylesheet" href="../../styles.css">
</head>
<body>
<nav>
    <a href="../../index.html">🌳 Media Tree</a>
    <a href="../../index.html">📝 About Me</a>
    <a href="../../index.html">📰 Blogs</a>
</nav>
<section class="page active">
    <div class="card">
        <a href="../../index.html" class="back-btn">⬅ Back to site</a>
        <div id="blogContent">${bodySection}
        </div>
    </div>
</section>
</body>
</html>
`;
}

// fetches the current sha for a path if it exists, or undefined if it's a
// new file -- GitHub's Contents API needs the sha to overwrite, and errors
// if you send one for a file that doesn't exist yet. A plain fetch (not
// apiRequest) so a 404 can be told apart from a real problem -- treating
// every failure as "doesn't exist yet" would silently swallow auth/rate
// limit errors instead of surfacing them.
async function getExistingSha(path){
    const token = getToken();
    if(!token){
        handleLogout();
        throw new Error('Not logged in.');
    }
    const res = await fetch(`${API}/contents/${path}?ref=main`, { headers: authHeaders(token) });
    if(res.status === 404) return undefined;
    if(!res.ok) throw await apiError(res);
    const json = await res.json();
    return json.sha;
}

async function uploadStandalonePostPage(post, allPosts){
    const path = `blog/${post.slug}/index.html`;
    const html = buildStandalonePostHtml(post, allPosts);
    const sha = await getExistingSha(path);
    await apiRequest(`/contents/${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: `Update standalone page: ${post.title}`,
            content: utf8ToBase64(html),
            sha,
            branch: 'main'
        })
    });
}

async function deleteStandalonePostPage(slug, title){
    const path = `blog/${slug}/index.html`;
    const sha = await getExistingSha(path);
    if(!sha) return; // never had one (e.g. published before this feature existed)
    await apiRequest(`/contents/${path}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: `Delete standalone page: ${title}`,
            sha,
            branch: 'main'
        })
    });
}

function buildSitemapXml(posts){
    const urls = [SITE_BASE_URL, ...posts.map(p => `${SITE_BASE_URL}blog/${p.slug}/`)];
    const entries = urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

async function uploadSitemap(posts){
    const sha = await getExistingSha('sitemap.xml');
    await apiRequest('/contents/sitemap.xml', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: 'Update sitemap.xml',
            content: utf8ToBase64(buildSitemapXml(posts)),
            sha,
            branch: 'main'
        })
    });
}

// ===== STRING-LEVEL SPLICING (never a full DOMParser round-trip on write --
// that can silently reformat unrelated markup and drops the doctype) =====
function getAnchorBounds(html){
    const start = html.indexOf(ANCHOR_START);
    const end = html.indexOf(ANCHOR_END);
    if(start === -1 || end === -1 || end < start){
        throw new Error('Could not find the blog-list anchor comments in index.html -- they may have been removed. Aborting to avoid corrupting the file.');
    }
    return { start, end };
}

function indexOfDivTag(html, fromIndex){
    const m = html.slice(fromIndex).match(/<div[\s>]/i);
    return m ? fromIndex + m.index : -1;
}

function findMatchingDivClose(html, openTagIndex){
    let pos = html.indexOf('>', openTagIndex) + 1;
    let depth = 1;
    while(depth > 0){
        const nextOpen = indexOfDivTag(html, pos);
        const nextClose = html.indexOf('</div>', pos);
        if(nextClose === -1) throw new Error('Malformed HTML while locating the end of a blog-preview block.');
        if(nextOpen !== -1 && nextOpen < nextClose){
            depth++;
            pos = html.indexOf('>', nextOpen) + 1;
        } else {
            depth--;
            pos = nextClose + '</div>'.length;
        }
    }
    return pos;
}

function findPostBlock(html, slug){
    const { start, end } = getAnchorBounds(html);
    const region = html.slice(start, end);
    const marker = `data-slug="${slug}"`;
    const markerIdx = region.indexOf(marker);
    if(markerIdx === -1){
        throw new Error(`Post "${slug}" not found -- it may have been edited or deleted since this page loaded. Reload and try again.`);
    }
    const blockStartInRegion = region.lastIndexOf('<div class="blog-preview"', markerIdx);
    if(blockStartInRegion === -1){
        throw new Error(`Could not locate the start of post "${slug}"'s block.`);
    }
    const blockEndInRegion = findMatchingDivClose(region, blockStartInRegion);
    return {
        absoluteStart: start + blockStartInRegion,
        absoluteEnd: start + blockEndInRegion
    };
}

function spliceInsertPost(html, blockHtml){
    const { start } = getAnchorBounds(html);
    const insertAt = start + ANCHOR_START.length;
    return html.slice(0, insertAt) + '\n\n            ' + blockHtml.trim() + html.slice(insertAt);
}

function spliceReplacePost(html, slug, newBlockHtml){
    const { absoluteStart, absoluteEnd } = findPostBlock(html, slug);
    return html.slice(0, absoluteStart) + newBlockHtml.trim() + html.slice(absoluteEnd);
}

function spliceDeletePost(html, slug){
    const { absoluteStart, absoluteEnd } = findPostBlock(html, slug);
    return html.slice(0, absoluteStart) + html.slice(absoluteEnd);
}

// ===== READING POSTS (DOMParser is fine for reading, never for writing) =====
function extractBodyHtml(fullContentEl){
    // buildBlogPreviewHtml() always prepends an <h1> + .blog-img-full ahead of
    // the authored body -- strip those back out so editing doesn't duplicate them.
    const clone = fullContentEl.cloneNode(true);
    const h1 = clone.querySelector('h1');
    if(h1) h1.remove();
    const img = clone.querySelector('.blog-img-full');
    if(img) img.remove();
    return clone.innerHTML.trim();
}

function parsePosts(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll('.blog-preview')).map(el => {
        const previewImgPath = el.querySelector('.blog-img') ? el.querySelector('.blog-img').getAttribute('src') : '';
        const headerImgPath = el.querySelector('.blog-img-full') ? el.querySelector('.blog-img-full').getAttribute('src') : '';
        return {
            slug: el.dataset.slug,
            title: el.querySelector('h2') ? el.querySelector('h2').textContent : '',
            summary: el.querySelector('.summary') ? el.querySelector('.summary').textContent : '',
            date: el.dataset.date,
            tags: (el.dataset.tags || '').split(' ').filter(Boolean),
            previewImgPath,
            // only treat the header image as "explicitly set" if it differs from
            // the preview image -- otherwise it's just the fallback reuse from
            // buildBlogPreviewHtml(), and the edit form should show it as blank
            // (still-optional) rather than as a distinct chosen image
            headerImgPath: headerImgPath && headerImgPath !== previewImgPath ? headerImgPath : '',
            bodyHtml: el.querySelector('.full-content') ? extractBodyHtml(el.querySelector('.full-content')) : '',
            parentSlug: el.dataset.parent || ''
        };
    });
}

// ===== UI STATE =====
let quill = null;
let currentTags = [];
let editingSlug = null; // null while creating a new post
let existingPreviewImgPath = null; // kept when editing and no new file was picked
let existingHeaderImgPath = null; // '' means "reuse the preview image", same as never having set one
let existingParentSlug = ''; // the post's series membership *before* this edit -- needed to tell if it changed
let allPosts = []; // refreshed by refreshPostList(); used to populate the series/parent dropdown without a refetch

// populates the "Belongs to series" dropdown with every top-level post
// (episodes can't themselves be a series parent, so >2-level nesting isn't possible)
function populateParentOptions(excludeSlug){
    const select = document.getElementById('fieldParent');
    select.innerHTML = '<option value="">None &mdash; standalone post</option>';
    allPosts
        .filter(p => p.slug !== excludeSlug && !p.parentSlug)
        .forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.slug;
            opt.textContent = p.title;
            select.appendChild(opt);
        });
}

function initQuill(){
    if(quill) return;
    quill = new Quill('#quillEditor', {
        theme: 'snow',
        modules: {
            toolbar: {
                container: [
                    [{ header: [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ align: [] }],
                    [{ indent: '-1' }, { indent: '+1' }],
                    ['blockquote'],
                    [{ list: 'ordered' }, { list: 'bullet' }],
                    ['link', 'image'],
                    ['clean']
                ],
                handlers: { image: handleQuillImageInsert }
            }
        }
    });

    // clicking an image already in the post opens the same width prompt used
    // at insert time, so images can be resized (or paired up side by side)
    // after the fact -- a plain click doesn't select the embed as a Quill
    // range (clicking an atomic embed just places the cursor next to it, it
    // doesn't set range.length to 1), so this has to work off the DOM node
    // the click actually landed on rather than quill.getSelection()
    quill.root.addEventListener('click', (e) => {
        if(e.target.tagName !== 'IMG') return;
        const blot = Quill.find(e.target);
        if(!blot) return;
        const index = quill.getIndex(blot);
        const current = (e.target.getAttribute('width') || '100').replace('%', '');
        const width = promptImageWidth(current);
        quill.formatText(index, 1, 'width', width < 100 ? width + '%' : '');
    });
}

function handleQuillImageInsert(){
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        const file = input.files[0];
        if(!file) return;
        const range = quill.getSelection(true);
        // alt text is required for accessibility -- fall back to the post title
        // rather than leaving inline images with no alt attribute at all
        const altText = prompt('Alt text for this image (for screen readers):', '') || document.getElementById('fieldTitle').value.trim() || 'Blog post image';
        const width = promptImageWidth('100');
        setFormStatus('Uploading image...');
        try{
            const slugHint = editingSlug || slugify(document.getElementById('fieldTitle').value) || 'post';
            const path = await uploadImage(file, slugHint);
            quill.insertEmbed(range.index, 'image', path);
            quill.formatText(range.index, 1, 'alt', altText);
            if(width < 100) quill.formatText(range.index, 1, 'width', width + '%');
            quill.setSelection(range.index + 1);
            setFormStatus('');
        }catch(e){
            setFormStatus('Image upload failed: ' + e.message);
        }
    };
    input.click();
}

// asks for a width as a % of the post column; clamped to a sane range,
// falls back to fallback (as a number) on cancel/blank/garbage input
function promptImageWidth(fallback){
    const input = prompt('Image width as a % of the post column (100 = full width; try around 45 if you want two images to sit side by side):', fallback);
    if(input === null) return parseInt(fallback, 10);
    const parsed = parseInt(input, 10);
    if(Number.isNaN(parsed)) return parseInt(fallback, 10);
    return Math.min(100, Math.max(10, parsed));
}

// ===== TOKEN GATE =====
async function handleTokenSubmit(){
    const input = document.getElementById('tokenInput');
    const errorEl = document.getElementById('gateError');
    const token = input.value.trim();
    errorEl.textContent = '';
    if(!token){ errorEl.textContent = 'Paste a token first.'; return; }

    const btn = document.getElementById('tokenSubmit');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    try{
        await validateToken(token);
        localStorage.setItem(TOKEN_KEY, token);
        unlockEditor();
    }catch(e){
        errorEl.textContent = e.message;
    }finally{
        btn.disabled = false;
        btn.textContent = 'Unlock';
    }
}

function handleLogout(){
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
}

function unlockEditor(){
    document.getElementById('gate').classList.remove('active');
    document.getElementById('editorPage').classList.add('active');
    initQuill();
    showListView();
}

// ===== LIST VIEW =====
async function refreshPostList(){
    const statusEl = document.getElementById('listStatus');
    const listEl = document.getElementById('postList');
    statusEl.textContent = 'Loading...';
    listEl.innerHTML = '';
    try{
        const { html } = await fetchIndexHtml();
        const posts = parsePosts(html);
        posts.sort((a, b) => new Date(b.date) - new Date(a.date));
        allPosts = posts;

        if(posts.length === 0){
            statusEl.textContent = 'No posts yet.';
            return;
        }
        statusEl.textContent = '';

        posts.forEach(post => {
            const parentPost = post.parentSlug ? posts.find(p => p.slug === post.parentSlug) : null;
            const parentLine = parentPost ? `<div class="admin-post-parent">&#8618; Part of: ${escapeHtml(parentPost.title)}</div>` : '';
            const row = document.createElement('div');
            row.className = 'admin-post-row';
            row.innerHTML = `
                <div>
                    <div class="admin-post-title">${escapeHtml(post.title)}</div>
                    <div class="admin-post-meta">${escapeHtml(post.date)} &middot; ${escapeHtml(post.tags.map(t => '#' + t).join(' '))}</div>
                    ${parentLine}
                </div>
                <div class="admin-post-actions">
                    <button type="button" data-action="edit">Edit</button>
                    <button type="button" class="danger" data-action="delete">Delete</button>
                </div>
            `;
            row.querySelector('[data-action="edit"]').onclick = () => showEditPostForm(post);
            row.querySelector('[data-action="delete"]').onclick = () => handleDelete(post.slug, post.title);
            listEl.appendChild(row);
        });
    }catch(e){
        statusEl.textContent = 'Error: ' + e.message;
    }
}

function showListView(){
    document.getElementById('listView').style.display = 'block';
    document.getElementById('formView').style.display = 'none';
    refreshPostList();
}

async function handleDelete(slug, title){
    const children = allPosts.filter(p => p.parentSlug === slug);
    const message = children.length > 0
        ? `"${title}" has ${children.length} episode(s) nested under it (${children.map(c => c.title).join(', ')}). Deleting it won't delete those episodes, but they'll no longer be reachable from the site since they only show up nested under this post. Delete anyway?`
        : `Delete "${title}"? This can't be undone from the admin page (though it stays recoverable from git history).`;
    if(!confirm(message)) return;

    try{
        const { html, sha } = await fetchIndexHtml();
        const newHtml = spliceDeletePost(html, slug);
        await putIndexHtml(newHtml, sha, `Delete blog post: ${title}`);
        showToast('Post deleted.');
        refreshPostList();

        // best-effort cleanup of the standalone SEO page + sitemap entry --
        // the post itself is already gone either way, so a failure here
        // just means a stale (but harmless, unlinked) page lingers
        try{
            await deleteStandalonePostPage(slug, title);
            const remainingPosts = parsePosts(newHtml);
            // if the deleted post was an episode, its series page still
            // links to it and needs to be regenerated without that entry
            const deletedPost = allPosts.find(p => p.slug === slug);
            if(deletedPost && deletedPost.parentSlug){
                const parentPost = remainingPosts.find(p => p.slug === deletedPost.parentSlug);
                if(parentPost) await uploadStandalonePostPage(parentPost, remainingPosts);
            }
            await uploadSitemap(remainingPosts);
        }catch(cleanupErr){
            console.error('Standalone page cleanup failed:', cleanupErr);
        }
    }catch(e){
        showToast('Delete failed: ' + e.message, true);
    }
}

// ===== FORM VIEW =====
function showNewPostForm(){
    editingSlug = null;
    existingPreviewImgPath = null;
    existingHeaderImgPath = null;
    existingParentSlug = '';
    currentTags = [];

    document.getElementById('fieldTitle').value = '';
    document.getElementById('fieldSummary').value = '';
    document.getElementById('fieldDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('fieldPreviewImage').value = '';
    document.getElementById('fieldHeaderImage').value = '';
    document.getElementById('previewImagePreview').style.display = 'none';
    document.getElementById('headerImagePreview').style.display = 'none';
    populateParentOptions(null);
    document.getElementById('fieldParent').value = '';
    quill.setContents([]);
    renderTagChips();
    setFormStatus('');

    document.getElementById('listView').style.display = 'none';
    document.getElementById('formView').style.display = 'block';
}

function showEditPostForm(post){
    editingSlug = post.slug;
    existingPreviewImgPath = post.previewImgPath;
    existingHeaderImgPath = post.headerImgPath;
    existingParentSlug = post.parentSlug || '';
    currentTags = post.tags.slice();

    document.getElementById('fieldTitle').value = post.title;
    document.getElementById('fieldSummary').value = post.summary;
    document.getElementById('fieldDate').value = post.date;
    document.getElementById('fieldPreviewImage').value = '';
    document.getElementById('fieldHeaderImage').value = '';

    const previewImg = document.getElementById('previewImagePreview');
    if(post.previewImgPath){
        previewImg.src = post.previewImgPath;
        previewImg.style.display = 'block';
    }else{
        previewImg.style.display = 'none';
    }

    const headerImg = document.getElementById('headerImagePreview');
    if(post.headerImgPath){
        headerImg.src = post.headerImgPath;
        headerImg.style.display = 'block';
    }else{
        headerImg.style.display = 'none';
    }

    populateParentOptions(post.slug);
    document.getElementById('fieldParent').value = post.parentSlug || '';

    quill.setContents([]);
    quill.clipboard.dangerouslyPasteHTML(post.bodyHtml);
    renderTagChips();
    setFormStatus('');

    document.getElementById('listView').style.display = 'none';
    document.getElementById('formView').style.display = 'block';
}

function handleTagKeydown(e){
    if(e.key === 'Enter' || e.key === ','){
        e.preventDefault();
        const raw = e.target.value.trim();
        if(raw){
            const tag = slugify(raw);
            if(tag && !currentTags.includes(tag)) currentTags.push(tag);
        }
        e.target.value = '';
        renderTagChips();
    }
}

function renderTagChips(){
    const wrap = document.getElementById('tagInputWrap');
    Array.from(wrap.querySelectorAll('.admin-tag-chip')).forEach(el => el.remove());
    const input = document.getElementById('fieldTagEntry');
    currentTags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'admin-tag-chip';
        chip.innerHTML = `${escapeHtml(tag)} <button type="button" aria-label="Remove tag ${escapeAttr(tag)}">&times;</button>`;
        chip.querySelector('button').onclick = () => {
            currentTags = currentTags.filter(t => t !== tag);
            renderTagChips();
        };
        wrap.insertBefore(chip, input);
    });
    renderTagSuggestions();
}

// every tag already used anywhere on the site, minus ones already added to
// this post -- lets a new/rare tag stay easy to spell consistently instead
// of retyping it (and risking a near-duplicate like "tv" vs "television")
function renderTagSuggestions(){
    const container = document.getElementById('tagSuggestions');
    if(!container) return;
    const allTags = new Set();
    allPosts.forEach(post => post.tags.forEach(t => allTags.add(t)));
    currentTags.forEach(t => allTags.delete(t));

    container.innerHTML = '';
    if(allTags.size === 0) return;

    Array.from(allTags).sort().forEach(tag => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'admin-tag-suggestion-chip';
        chip.textContent = '+ ' + tag;
        chip.onclick = () => {
            currentTags.push(tag);
            renderTagChips();
        };
        container.appendChild(chip);
    });
}

function handleImageChange(e, kind){
    const file = e.target.files[0];
    const preview = document.getElementById(kind === 'header' ? 'headerImagePreview' : 'previewImagePreview');
    if(!file){
        preview.style.display = 'none';
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        preview.src = reader.result;
        preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
}

function setFormStatus(msg){
    document.getElementById('formStatus').textContent = msg;
}

// ===== PUBLISH =====
async function handlePublish(){
    const title = document.getElementById('fieldTitle').value.trim();
    const summary = document.getElementById('fieldSummary').value.trim();
    const date = document.getElementById('fieldDate').value;
    const previewImageFile = document.getElementById('fieldPreviewImage').files[0];
    const headerImageFile = document.getElementById('fieldHeaderImage').files[0];
    const parentSlug = document.getElementById('fieldParent').value;
    const bodyHtml = quill.root.innerHTML;

    if(!title){ setFormStatus('Title is required.'); return; }
    if(!date){ setFormStatus('Date is required.'); return; }
    if(!previewImageFile && !existingPreviewImgPath){ setFormStatus('A preview image is required.'); return; }

    const btn = document.getElementById('publishBtn');
    btn.disabled = true;

    try{
        setFormStatus('Fetching latest post list...');
        let { html, sha } = await fetchIndexHtml();
        const existingSlugs = parsePosts(html).map(p => p.slug).filter(s => s !== editingSlug);

        let slug = editingSlug;
        if(!slug){
            slug = uniqueSlug(slugify(title), existingSlugs);
        }

        let previewImgPath = existingPreviewImgPath;
        if(previewImageFile){
            setFormStatus('Uploading preview image...');
            previewImgPath = await uploadImage(previewImageFile, `${slug}-preview`);
        }

        // header image is optional -- keep it blank (falls back to the
        // preview image in buildBlogPreviewHtml) unless one was actually set
        let headerImgPath = existingHeaderImgPath;
        if(headerImageFile){
            setFormStatus('Uploading header image...');
            headerImgPath = await uploadImage(headerImageFile, `${slug}-header`);
        }

        const post = { slug, title, summary, tags: currentTags, date, previewImgPath, headerImgPath, bodyHtml, parentSlug };
        const blockHtml = buildBlogPreviewHtml(post);

        setFormStatus('Saving post...');
        // re-fetch immediately before the write in case the image upload above took a while
        ({ html, sha } = await fetchIndexHtml());

        const newHtml = editingSlug
            ? spliceReplacePost(html, editingSlug, blockHtml)
            : spliceInsertPost(html, blockHtml);

        await putIndexHtml(newHtml, sha, editingSlug ? `Edit blog post: ${title}` : `Add blog post: ${title}`);

        // give the post its own crawlable URL for search engines, and keep
        // the sitemap in sync -- best-effort: the post itself is already
        // live either way, so a failure here shouldn't block the publish
        let seoWarning = '';
        try{
            setFormStatus('Publishing standalone page...');
            const allPostsNow = parsePosts(newHtml);
            await uploadStandalonePostPage(post, allPostsNow);
            // if this post belongs to a series, that series's own standalone
            // page needs to be regenerated too -- its episode list is only
            // as current as the last time IT was published, so without this
            // a series page would keep listing a stale set of episodes
            // every time a new one is added
            if(parentSlug){
                const parentPost = allPostsNow.find(p => p.slug === parentSlug);
                if(parentPost) await uploadStandalonePostPage(parentPost, allPostsNow);
            }
            // if this post used to belong to a *different* series (or used
            // to be an episode and now isn't), that OLD series's page still
            // links to it and needs to be regenerated to drop the stale entry
            if(existingParentSlug && existingParentSlug !== parentSlug){
                const oldParentPost = allPostsNow.find(p => p.slug === existingParentSlug);
                if(oldParentPost) await uploadStandalonePostPage(oldParentPost, allPostsNow);
            }
            await uploadSitemap(allPostsNow);
        }catch(seoErr){
            console.error('Standalone page publish failed:', seoErr);
            seoWarning = ' (its SEO page failed to update: ' + seoErr.message + ')';
        }

        showToast('Published! GitHub Pages will redeploy in about a minute.' + seoWarning, !!seoWarning);
        showListView();
    }catch(e){
        if(e.message === 'CONFLICT'){
            setFormStatus('index.html changed since this page loaded (maybe from another tab, or a manual push). Your form is unchanged -- click Publish again to retry with the latest version.');
        }else{
            setFormStatus('Error: ' + e.message);
        }
    }finally{
        btn.disabled = false;
    }
}

// ===== TOAST =====
let toastTimer = null;
function showToast(msg, isError){
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = isError ? 'admin-toast error' : 'admin-toast';
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 5000);
}

// ===== INIT =====
(async function init(){
    const saved = getToken();
    if(!saved) return;
    try{
        await validateToken(saved);
        unlockEditor();
    }catch(e){
        localStorage.removeItem(TOKEN_KEY);
        document.getElementById('gateError').textContent = 'Saved token no longer works: ' + e.message;
    }
})();
