// Create this as functions/test-firebase.js to test Firebase write operations
// This will tell us exactly why new records aren't being saved

const admin = require('firebase-admin');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  try {
    console.log('=== FIREBASE TEST STARTING ===');
    console.log('Environment check:', {
      hasServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      serviceAccountLength: process.env.FIREBASE_SERVICE_ACCOUNT ? process.env.FIREBASE_SERVICE_ACCOUNT.length : 0,
      hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
      nodeEnv: process.env.NODE_ENV
    });

    // Initialize Firebase if not already done
    if (admin.apps.length === 0) {
      console.log('Initializing Firebase...');
      
      let serviceAccount;
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('Service account parsed successfully');
        console.log('Project ID from service account:', serviceAccount.project_id);
      } catch (parseError) {
        console.error('Error parsing service account:', parseError.message);
        throw new Error('Failed to parse FIREBASE_SERVICE_ACCOUNT');
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });
      console.log('Firebase initialized successfully');
    } else {
      console.log('Firebase already initialized');
    }

    // Test Firestore connection
    console.log('Testing Firestore connection...');
    const db = admin.firestore();
    
    // Try to write a test document
    console.log('Writing test document...');
    const testRef = db.collection('phoneEmailMappings').doc('test-contact');
    await testRef.set({
      phoneNumber: '+15551234567',
      email: 'test@example.com',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      testDocument: true
    });
    console.log('Test document written successfully');

    // Try to read it back
    console.log('Reading test document...');
    const testDoc = await testRef.get();
    if (testDoc.exists) {
      console.log('Test document read successfully:', testDoc.data());
    } else {
      console.log('Test document not found after writing');
    }

    // Try to list all documents in the collection
    console.log('Listing all documents in phoneEmailMappings...');
    const snapshot = await db.collection('phoneEmailMappings').limit(5).get();
    console.log(`Found ${snapshot.size} documents in collection`);
    
    const docs = [];
    snapshot.forEach(doc => {
      docs.push({ id: doc.id, data: doc.data() });
    });

    // Clean up test document
    console.log('Cleaning up test document...');
    await testRef.delete();
    console.log('Test document deleted');

    console.log('=== FIREBASE TEST COMPLETED SUCCESSFULLY ===');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Firebase test completed successfully',
        documentsFound: snapshot.size,
        testData: docs
      })
    };

  } catch (error) {
    console.error('=== FIREBASE TEST FAILED ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        stack: error.stack
      })
    };
  }
};
