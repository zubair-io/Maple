import { MongoClient } from 'mongodb';

async function run() {
  const mongoUrl = 'mongodb://192.168.0.244:27017';
  console.log('Connecting to:', mongoUrl);
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db('maple');
  const assets = db.collection('assets');

  const doc = await assets.findOne({ 'fileinfo.filename': '084A0433.CR2' });
  if (doc) {
    console.log('Document metadata fields:');
    console.log(JSON.stringify({
      _id: doc._id,
      maple_id: doc.maple_id,
      fileinfo: doc.fileinfo,
      metadata_override: doc.metadata_override,
      place: doc.place,
      stages: doc.stages,
    }, null, 2));
  } else {
    console.log('Document not found');
  }

  await client.close();
}

run().catch(console.error);
