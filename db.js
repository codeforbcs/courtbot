require('dotenv').config();
const crypto = require('crypto');
const manager = require('./utils/db/manager');
const knex = manager.knex;

/**
 * encrypts the phone number
 *
 * param {string} phone number to encrypt
 * returns {string} encrypted phone number
 */
function encryptPhone(phone) {
    // Be careful when refactoring this function, the decipher object needs to be created
    //    each time a reminder is sent because the decipher.final() method destroys the object
    //    Reference: https://nodejs.org/api/crypto.html#crypto_decipher_final_output_encoding
    const cipher = crypto.createCipher('aes256', process.env.PHONE_ENCRYPTION_KEY);
    return cipher.update(phone, 'utf8', 'hex') + cipher.final('hex');
}

/**
 * decrypts the phone number
 *
 * param {string} phone number to decrypt
 * returns {string} decrypted phone number
 */
function decryptPhone(phone) {
    // Be careful when refactoring this function, the decipher object needs to be created
    //    each time a reminder is sent because the decipher.final() method destroys the object
    //    Reference: https://nodejs.org/api/crypto.html#crypto_decipher_final_output_encoding
    const decipher = crypto.createDecipher('aes256', process.env.PHONE_ENCRYPTION_KEY);
    return decipher.update(phone, 'hex', 'utf8') + decipher.final('utf8');
}

/**
 * Given a case id return the hearing(s)
 * @param {string} case_id
 * return
 */
function findCitation(case_id) {
    return knex('hearings').where('case_id', case_id )
    .select('*', knex.raw(`
        CURRENT_DATE = date_trunc('day', date) as today,
        date < CURRENT_TIMESTAMP as has_past
    `))
}
/**
 * Find request's case_ids based on phone
 * @param {string} phone
 * @returns {Promise} resolves to an array of case_ids
 */
function requestsFor(phone) {
    return knex('requests')
    .where('phone', encryptPhone(phone))
    .select('case_id')
}
/**
 * Deletes requests associated with phone number
 * @param {string} phone
 * @returns {Promise} resolves deleted case ids
 */
function deleteRequestsFor(phone){
    return knex('requests')
    .where('phone', encryptPhone(phone))
    .del()
    .returning('case_id')
}

/**
 * Find hearings based on case_id or partial name search
 * @param {string} str
 * @returns {Promise} array of rows from hearings table
 */
function fuzzySearch(str) {
    const parts = str.trim().toUpperCase().split(' ');

    // Search for Names
    let query = knex('hearings').where('defendant', 'ilike', `%${parts[0]}%`);
    if (parts.length > 1) query = query.andWhere('defendant', 'ilike', `%${parts[1]}%`);

    // Search for Citations
    query = query.orWhere('case_id',parts[0]);

    // Limit to ten results
    query = query.limit(10);
    return query;
}

/**
 * Adds the given request. Requests have a unique constraint on (case_id, phone)
 * adding a duplicate will renew the updated_at date, which in the case of unmatched
 * requests will start the clock on them again
 * @param {*} data
 * @returns {Promise} no resolve value
 */
function addRequest(data) {
    return knex.raw(`
        INSERT INTO requests
        (case_id, phone, known_case)
        VALUES(:case_id ,:phone, :known_case)
        ON CONFLICT (case_id, phone) DO UPDATE SET updated_at = NOW()`,
        {
            case_id: data.case_id,
            phone: encryptPhone(data.phone),
            known_case: data.known_case
        }
    )
}

module.exports = {
    addRequest,
    decryptPhone,
    encryptPhone,
    findCitation,
    fuzzySearch,
    deleteRequestsFor,
    requestsFor,
};
