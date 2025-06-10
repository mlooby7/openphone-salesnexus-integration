const admin = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
    } catch (error) {
        console.error('Failed to initialize Firebase:', error);
        throw error;
    }
}

const db = admin.firestore();

exports.handler = async (event, context) => {
    // Add CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle OPTIONS request for CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    try {
        const path = event.path.replace('/.netlify/functions/mapping', '') || '/';
        
        if (event.httpMethod === 'GET' && path === '/') {
            // Return all mappings - LIMIT TO PREVENT QUOTA ISSUES
            try {
                const snapshot = await db.collection('phoneMappings').limit(100).get();
                const mappings = [];
                snapshot.forEach(doc => {
                    const data = doc.data();
                    mappings.push({
                        phoneNumber: doc.id,
                        emails: Array.isArray(data.emails) ? data.emails : [data.email].filter(Boolean)
                    });
                });
                
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify(mappings)
                };
            } catch (error) {
                console.error('Error fetching mappings:', error);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: 'Failed to fetch mappings', details: error.message })
                };
            }
        }

        if (event.httpMethod === 'POST' && path === '/lookup') {
            // Lookup phone number
            try {
                const { phoneNumber } = JSON.parse(event.body);
                
                if (!phoneNumber) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ error: 'Phone number is required' })
                    };
                }

                const doc = await db.collection('phoneMappings').doc(phoneNumber).get();
                
                if (!doc.exists) {
                    return {
                        statusCode: 404,
                        headers,
                        body: JSON.stringify({ error: 'Mapping not found' })
                    };
                }

                const data = doc.data();
                const emails = Array.isArray(data.emails) ? data.emails : [data.email].filter(Boolean);
                
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        emails: emails,
                        email: emails[0] || '', // For backward compatibility
                        count: emails.length
                    })
                };
            } catch (error) {
                console.error('Error looking up phone:', error);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: 'Failed to lookup phone', details: error.message })
                };
            }
        }

        if (event.httpMethod === 'POST' && path === '/') {
            // Add/Update mapping
            try {
                const body = JSON.parse(event.body);
                
                if (Array.isArray(body)) {
                    // Batch operation - LIMIT TO PREVENT QUOTA ISSUES
                    const batch = db.batch();
                    const limitedMappings = body.slice(0, 50); // Limit to 50 at a time
                    
                    limitedMappings.forEach(mapping => {
                        if (mapping.phoneNumber && mapping.emails) {
                            const docRef = db.collection('phoneMappings').doc(mapping.phoneNumber);
                            batch.set(docRef, {
                                emails: Array.isArray(mapping.emails) ? mapping.emails : [mapping.emails].filter(Boolean),
                                updatedAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                        }
                    });
                    
                    await batch.commit();
                    
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ 
                            message: `Saved ${limitedMappings.length} mappings`,
                            processed: limitedMappings.length,
                            total: body.length
                        })
                    };
                } else {
                    // Single mapping
                    const { phoneNumber, emails, email } = body;
                    
                    if (!phoneNumber) {
                        return {
                            statusCode: 400,
                            headers,
                            body: JSON.stringify({ error: 'Phone number is required' })
                        };
                    }

                    const emailArray = emails || (email ? [email] : []);
                    
                    if (emailArray.length === 0) {
                        return {
                            statusCode: 400,
                            headers,
                            body: JSON.stringify({ error: 'At least one email is required' })
                        };
                    }

                    await db.collection('phoneMappings').doc(phoneNumber).set({
                        emails: emailArray,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ message: 'Mapping saved successfully' })
                    };
                }
            } catch (error) {
                console.error('Error saving mapping:', error);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: 'Failed to save mapping', details: error.message })
                };
            }
        }

        if (event.httpMethod === 'DELETE' && path.startsWith('/')) {
            // Delete mapping
            try {
                const phoneNumber = decodeURIComponent(path.substring(1));
                
                if (!phoneNumber) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ error: 'Phone number is required' })
                    };
                }

                await db.collection('phoneMappings').doc(phoneNumber).delete();

                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ message: 'Mapping deleted successfully' })
                };
            } catch (error) {
                console.error('Error deleting mapping:', error);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: 'Failed to delete mapping', details: error.message })
                };
            }
        }

        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Not found' })
        };

    } catch (error) {
        console.error('Handler error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', details: error.message })
        };
    }
};
