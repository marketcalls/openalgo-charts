export default {
  index: {
    title: 'Home',
    display: 'hidden',
    theme: {
      layout: 'raw',
      sidebar: false,
      toc: false,
      breadcrumb: false,
      pagination: false,
      footer: true,
    },
  },
  docs: {
    title: 'Documentation',
    type: 'page',
  },
  examples: {
    title: 'Examples',
    type: 'page',
    theme: { layout: 'full', toc: false },
  },
  api: {
    title: 'API Reference',
    type: 'page',
    href: '/openalgo-charts/api/',
    newWindow: true,
  },
};
