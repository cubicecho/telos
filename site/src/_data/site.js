// Everything the layout needs to say who this is.
export default {
  name: "telos",
  tagline: "A self-hostable todo board, and agents to work it if you want them.",
  description:
    "Telos is a self-hostable todo board: projects, lanes, todos that can depend on other todos, and labels. Give a lane an agent and it works each todo that arrives there. One container plus Postgres.",
  url: "https://cubicecho.github.io/telos/",
  repo: "https://github.com/cubicecho/telos",
  org: "https://cubicecho.com",
  // Optional — the layout only renders the ones you set. Telos is not on npm;
  // the README's Quickstart pulls the published image.
  npm: null,
  docker: "https://hub.docker.com/r/vantreeseba/telos",
};
