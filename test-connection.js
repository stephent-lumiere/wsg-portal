require('dotenv').config();
const Airtable = require('airtable');

const base = new Airtable({ apiKey: process.env.AIRTABLE_PAT }).base(process.env.AIRTABLE_BASE_ID);

console.log('Connecting to Airtable...\n');

base(process.env.TABLE_NAME)
  .select({
    maxRecords: 3
  })
  .firstPage((err, records) => {
    if (err) {
      console.error('Error connecting to Airtable:', err.message);
      return;
    }

    console.log(`Successfully fetched ${records.length} record(s) from "${process.env.TABLE_NAME}":\n`);

    records.forEach((record, index) => {
      console.log(`Record ${index + 1}:`, record.fields);
    });
  });
