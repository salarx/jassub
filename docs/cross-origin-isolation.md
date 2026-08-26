# Cross-origin isolation

JASSUB uses `SharedArrayBuffer` for libass' worker threads, and that needs the page to be cross-origin
isolated. Without it the library still works, single-threaded, at roughly a third of the speed - see the
Requirements section of the [README](../README.md).

Setting the headers, for a few common hosts:

```
# Netlify, Cloudflare Pages - _headers
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

```js
// Express
app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin')
  res.set('Cross-Origin-Embedder-Policy', 'require-corp')
  next()
})
```

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

**`require-corp` will break cross-origin subresources that have not opted in**, and for a video player that
usually means the video itself. Every cross-origin image, font, subtitle and media file then needs either
`Cross-Origin-Resource-Policy: cross-origin` from the origin serving it, or CORS plus a `crossorigin`
attribute on the element. If the media is on a CDN you do not control, check this before shipping the
headers - the failure is the asset not loading at all, not subtitles being slow.

`Cross-Origin-Embedder-Policy: credentialless` is the softer option: it drops the CORP requirement by
sending cross-origin requests without credentials. Support is narrower, and anything that needs cookies to
fetch - signed URLs are usually fine, cookie-authenticated media is not - will fail instead.

`Cross-Origin-Opener-Policy: same-origin` also severs `window.opener`, so OAuth popups and similar flows
are worth testing once the headers are on.
