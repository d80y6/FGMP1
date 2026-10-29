import { Apinator } from '@apinator/server';

export const client = new Apinator({
  appId: '49c919b4-9f3a-4a8b-9ba4-3dc2764c30fa',
  key: 'app_2a3b390abfbd2bd0fd798ab03cf962efb1872408',
  secret: process.env.APINATOR_SECRET,
  cluster: 'us'
});

await client.trigger({
  name: 'my-event',
  channel: 'my-channel',
  data: JSON.stringify({ message: 'Hello!' })
});
