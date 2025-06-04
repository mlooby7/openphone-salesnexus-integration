const admin = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: process.env.FIREBASE_PROJECT_ID,
        });
        console.log('Firebase initialized successfully');
    } catch (error) {
        console.error('Failed to initialize Firebase:', error);
        throw error;
    }
}

const db = admin.firestore();

// Helper function to format phone number to E.164
function formatPhoneNumber(phone) {
    if (!phone) return null;
    
    // Remove all non-digit characters
    const digitsOnly = phone.replace(/\D/g, '');
    
    // If it starts with 1 and has 11 digits, it's already in the right format
    if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
        return '+' + digitsOnly;
    }
    
    // If it has 10 digits, add +1
    if (digitsOnly.length === 10) {
        return '+1' + digitsOnly;
    }
    
    // If it already starts with +, return as is
    if (phone.startsWith('+')) {
        return phone;
    }
    
    return phone;
}

// Helper function to parse CSV content
function parseCSV(csvContent) {
    const lines = csvContent.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const mappings = [];
    
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
        const phoneNumber = formatPhoneNumber(values[0]);
        const email = values[1];
        
        if (phoneNumber && email && email.includes('@')) {
            mappings.push({
                phoneNumber,
                email,
                contactName: values[2] || '',
                companyName: values[3] || '',
                phoneType: values[4] || 'Unknown'
            });
        }
    }
    
    return mappings;
}

exports.handler = async (event, context) => {
    // Enable CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const path = event.path.replace('/.netlify/functions/mapping', '') || '/';
        
        console.log(`Processing ${event.httpMethod} request to path: ${path}`);

        // GET /all - Get all mappings (with limit of 10000)
        if (event.httpMethod === 'GET' && path === '/all') {
            const snapshot = await db.collection('phoneEmailMappings').limit(10000).get();
            const mappings = [];
            
            snapshot.forEach(doc => {
                mappings.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            
            console.log(`Retrieved ${mappings.length} mappings from database`);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ mappings })
            };
        }

        // GET /count - Get count of all mappings
        if (event.httpMethod === 'GET' && path === '/count') {
            const snapshot = await db.collection('phoneEmailMappings').count().get();
            const count = snapshot.data().count;
            
            console.log(`Total mappings in database: ${count}`);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ count })
            };
        }

        // GET /sample - Get sample records for structure checking
        if (event.httpMethod === 'GET' && path === '/sample') {
            const snapshot = await db.collection('phoneEmailMappings').limit(3).get();
            const samples = [];
            
            snapshot.forEach(doc => {
                samples.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            
            console.log(`Retrieved ${samples.length} sample records`);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ samples })
            };
        }

        // GET /phones - Get all phone numbers for testing
        if (event.httpMethod === 'GET' && path === '/phones') {
            const snapshot = await db.collection('phoneEmailMappings').limit(100).get();
            const phones = [];
            
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.phoneNumber) {
                    phones.push(data.phoneNumber);
                }
            });
            
            console.log(`Retrieved ${phones.length} phone numbers`);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ phones })
            };
        }

        // POST /lookup - Look up email by phone number
        if (event.httpMethod === 'POST' && path === '/lookup') {
            const { phoneNumber } = JSON.parse(event.body);
            const formattedPhone = formatPhoneNumber(phoneNumber);
            
            console.log(`Looking up email for phone: ${formattedPhone}`);
            
            const doc = await db.collection('phoneEmailMappings').doc(formattedPhone).get();
            
            if (doc.exists) {
                const data = doc.data();
                console.log(`Found mapping for ${formattedPhone}: ${data.email}`);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ 
                        email: data.email,
                        contactName: data.contactName,
                        companyName: data.companyName,
                        phoneType: data.phoneType
                    })
                };
            } else {
                console.log(`No mapping found for ${formattedPhone}`);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ email: null })
                };
            }
        }

        // POST /add - Add single mapping
        if (event.httpMethod === 'POST' && path === '/add') {
            const { phoneNumber, email, contactName, companyName, phoneType } = JSON.parse(event.body);
            const formattedPhone = formatPhoneNumber(phoneNumber);
            
            if (!formattedPhone || !email) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Phone number and email are required' })
                };
            }
            
            await db.collection('phoneEmailMappings').doc(formattedPhone).set({
                phoneNumber: formattedPhone,
                email,
                contactName: contactName || '',
                companyName: companyName || '',
                phoneType: phoneType || 'Manual Entry',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log(`Added mapping: ${formattedPhone} -> ${email}`);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true })
            };
        }

        // POST /upload - Upload CSV mappings
        if (event.httpMethod === 'POST' && path === '/upload') {
            const { csvContent } = JSON.parse(event.body);
            
            if (!csvContent) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'CSV content is required' })
                };
            }
            
            const mappings = parseCSV(csvContent);
            
            if (mappings.length === 0) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'No valid mappings found in the CSV' })
                };
            }
            
            // Use batch operations for better performance
            const batch = db.batch();
            
            mappings.forEach(mapping => {
                const docRef = db.collection('phoneEmailMappings').doc(mapping.phoneNumber);
                batch.set(docRef, {
                    ...mapping,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            
            await batch.commit();
            
            console.log(`Successfully uploaded ${mappings.length} mappings`);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    success: true, 
                    count: mappings.length,
                    message: `Successfully uploaded ${mappings.length} phone-to-email mappings`
                })
            };
        }

        // DELETE /clear - Clear all mappings (for testing)
        if (event.httpMethod === 'DELETE' && path === '/clear') {
            const snapshot = await db.collection('phoneEmailMappings').get();
            const batch = db.batch();
            
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            await batch.commit();
            
            console.log(`Cleared ${snapshot.size} mappings from database`);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    success: true, 
                    deleted: snapshot.size,
                    message: `Cleared ${snapshot.size} mappings from database`
                })
            };
        }

        // If we get here, the path wasn't recognized
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: `Path not found: ${path}` })
        };

    } catch (error) {
        console.error('Error in mapping function:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Internal server error',
                details: error.message 
            })
        };
    }
};
