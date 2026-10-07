/**
 * Stand-in for the Amplience SDK when the page is opened directly in a browser (not inside
 * Amplience), so the importer can be tried locally.
 */
export function devSdk() {
  // A saved two-page flyer, so the editor can be tried locally.
  const image = (name: string) => ({
    _meta: { schema: 'http://bigcontent.io/cms/schema/v1/core#/definitions/image-link' },
    id: name,
    name,
    endpoint: 'scheelspoc',
    defaultHost: 'cdn.media.amplience.net',
  });
  let value: unknown = [
    { image: image('flyer-biggame26-p25'), hotspots: [] },
    {
      image: image('flyer-biggame26-p26'),
      hotspots: [
        {
          label: 'Pulsar Talion XG35 Scope',
          priceText: 'Now $2,199.97 · Reg. $3,499.97',
          box: { x: 70, y: 1, w: 29, h: 19 },
          skus: ['81011901034'],
          objectIds: ['810119-PL76563U'],
          fallback: { type: 'search', value: 'Pulsar Talion XG35 Scope' },
          locked: false,
          confidence: 'high',
        },
      ],
    },
  ];
  return {
    field: {
      getValue: async () => value,
      setValue: async (next: unknown) => {
        value = next;
        console.info('[dev] pages field set', next);
      },
    },
    form: {
      readOnly: false,
      getValue: async () => ({ title: '', campaign: '', startDate: '', endDate: '' }),
      onReadOnlyChange: () => undefined,
    },
    params: { installation: {}, instance: {} },
    frame: { startAutoResizer: () => undefined, setHeight: () => undefined },
  };
}
