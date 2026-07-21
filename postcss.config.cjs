// PostCSS must not inherit a parent workspace config (e.g. ~/Development/postcss.config.js
// with Tailwind v3). This app uses Tailwind v4 via @tailwindcss/vite only.
module.exports = {
  plugins: {}
};
