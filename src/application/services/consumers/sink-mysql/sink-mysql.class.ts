import Debug from 'debug';
import moment from 'moment-timezone';
import { ConsumerService } from '../consumer.class';
import { parseValueAsArray } from '../../../../utils';
import { Application, GenericObject, SinkMysqlConsumerServiceOptions } from '../../../../types/types';

const debug = Debug('metamorphosis:app:consumer:sink-mysql');
const debugError = Debug('metamorphosis:error');
const debugVerbose = Debug('metamorphosis:app:consumer:sink-mysql:verbose');

export class SinkMysqlConsumerService extends ConsumerService {
	/** Service options for this consumer */
	sinkMysqlConsumerOptions: SinkMysqlConsumerServiceOptions;

	/** MySql client */
	database;

	/**
	 * DefaultConsumerService constructor
	 *
	 * @param options
	 * @param app
	 */
	constructor(options: SinkMysqlConsumerServiceOptions, app: Application) {
		// Instantiate BaseConsumer
		super(options, app);

		this.sinkMysqlConsumerOptions = options;

		this.database = app.get('database');
	}

	/**
	 * Start consumer, subscribe to our topic and listen for batches of messages.
	 * Run message callback on every message recieved and write any errors to a new Kafka topic.
	 */
	async start(): Promise<this> {
		// Connect to  MySql
		await this.database.connect();

		// Run initial consumer connect and subscribe
		await super.start();

		/**
		 * Batch message
		 *
		 * {
		 *		topic: batch.topic,
		 *		partition: batch.partition,
		 *		highWatermark: batch.highWatermark,
		 *		message: {
		 *			offset: message.offset,
		 *			key: message.key
		 *				? message.key.toString()
		 *				: null,
		 *			value: message.value
		 *				? message.value.toString()
		 *				: null,
		 *			headers: message.headers
		 *				? message.headers.toString()
		 *				: null,
		 *		},
		 *	}
		 */
		await this.getConsumer().run({
			// Since we perform all database inserts for the entire batch, we do only want to commit batch offsets at the end of the batch
			eachBatchAutoResolve: true,
			eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }): Promise<void> => {
				debug(`Consuming batch of ${batch.messages.length} messages`);

				// Array of batched messages that will be inserted after entire batch is processed
				const batchInsertValues: any[] = [];

				// Keep track of fields since batch inserts must all have the same columns
				let batchFields: string[] = [];

				const { topic: batchTopic, messages } = batch;

				// Parse consumer options
				const { table: configTable } = this.sinkMysqlConsumerOptions || {};
				const {
					name: configTableName,
					topicRegex: configTableTopicRegex,
					topicRegexReplacement: configTableTopicRegexReplacement,
					topicPrefix: configTableTopicPrefix,
					topicSuffix: configTableTopicSuffix,
				} = configTable || {};

				for (const message of messages) {
					if (!isRunning() || isStale()) break;

					// Extract message value from Kafka message
					const { value: messageValueBuffer } = message || {};

					// Skip if no message `value`
					if (!messageValueBuffer) {
						resolveOffset(message.offset);
						continue;
					}

					let messageValue: GenericObject;

					// Kafka message value should be Avro encoded so decode, otherwise try to read as JSON-encoded Buffer
					// If unable to decode then skip as something is bunk with the message and it will never get past this offset
					try {
						messageValue = this.registry
							? await this.registry.decode(messageValueBuffer)
							: JSON.parse(messageValueBuffer.toString());
					} catch (err) {
						Debug('metamorphosis:app:consumer:sink-mysql:debug')('Failed parsing message: %o', err);
						resolveOffset(message.offset);
						continue;
					}

					let { values } = messageValue || {};
					const { table, pk, fields } = messageValue || {};

					// If message does not contain `values` key then assume the message value is a struct
					// containing all keys and values to insert.
					if (!values) {
						values = messageValue;
					}

					// Skip empty records
					if (!values) {
						continue;
					}

					// Get table name from message or config
					let tableNameDerivedFromPattern = batchTopic;

					if (configTableTopicRegex) {
						const topicMatches = configTableTopicRegex.exec(batchTopic);

						if (topicMatches.length) {
							tableNameDerivedFromPattern = configTableTopicRegexReplacement
								? configTableTopicRegexReplacement.replace('$1', topicMatches[1])
								: topicMatches[1];
						}
					} else if (configTableTopicPrefix || configTableTopicSuffix) {
						tableNameDerivedFromPattern = configTableTopicPrefix && batchTopic.replace(configTableTopicPrefix, '');
						tableNameDerivedFromPattern = configTableTopicSuffix && batchTopic.replace(configTableTopicSuffix, '');
					}

					// if (tableNameDerivedFromPattern !== batchTopic) {
					// 	Debug('metamorphosis:app:consumer:sink-mysql:debug')(
					// 		'Derived table name from topic: %s',
					// 		tableNameDerivedFromPattern
					// 	);
					// }

					// Order of precedence is table specified in message, explicitly in app config, or as a pattern suffix to all consumed topics
					const dbTable = table || configTableName || tableNameDerivedFromPattern;

					// Skip if no table can be derived
					if (!dbTable) {
						debugError('No table specificed for message:', messageValue);
						continue;
					}

					const { fields: fieldRules = {}, masks } = this.sinkMysqlConsumerOptions || {};
					const { whitelist, fromUnixtime, mask } = fieldRules;
					const { email: emailMask, phone: phoneMask } = mask || {};

					// Get fields that should be allowed (use all keys if empty)
					const whitelistFields = parseValueAsArray(whitelist);

					// Get fields that are passed as unix timestamps but should be converted to MySql date format YYYY-MM-DD HH:mm:ss
					const convertEpochFields = parseValueAsArray(fromUnixtime);

					const { emailHostname: maskEmailHostname } = masks || {};

					const emailMaskFields = parseValueAsArray(emailMask);
					const phoneMaskFields = parseValueAsArray(phoneMask);

					// Get field schema if not yet set for batch
					if (!batchFields.length) {
						batchFields = whitelistFields || Object.keys(values);
					}

					const rowData: GenericObject = Object.keys(values)
						// Only allow fields that exist in the batch which will be fields in the whitelist config is set,
						// otherwise allow all keys from the first valid message in the batch
						.filter(key => batchFields.includes(key))
						// Convert fields and values back into key/value object for sink
						.reduce((obj, key) => {
							let fieldValue = values[key];

							// Convert unix timestamps into MySql dates for specified fields.
							// This will convert to the local timezone which will be set on the MySQL insert
							if (
								!!convertEpochFields &&
								(convertEpochFields.includes(key) || convertEpochFields.includes(`${dbTable}.${key}`))
							) {
								// Any falsey values should be converted to null
								if (!fieldValue) {
									fieldValue = null;
								} else {
									let oDate = moment.unix(fieldValue / 1000);
									// Set timezone for client if passed to allow for proper TIMESTAMP data
									const timeZone = this.database.getTimezone();

									// Set timezone if configured
									if (timeZone) {
										oDate = oDate.tz(timeZone);
									}

									// Convert value to MySql datetime string
									fieldValue = oDate.isValid() ? oDate.format('YYYY-MM-DD HH:mm:ss') : null;
								}
							}

							// Mask email using VERP
							if (!!emailMaskFields && (emailMaskFields.includes(key) || emailMaskFields.includes(`${dbTable}.${key}`))) {
								fieldValue = !!fieldValue && fieldValue.replace('@', '=') + (maskEmailHostname || '@noreply.test');
							}

							// Mask phone by replacing with fake number
							// TODO: allow for proper i18n of number
							if (!!phoneMaskFields && (phoneMaskFields.includes(key) || phoneMaskFields.includes(`${dbTable}.${key}`))) {
								fieldValue = !!fieldValue && '19992223344';
							}

							// Add value to final object
							obj[key] = fieldValue;
							return obj;
						}, {});

					// Debug('metamorphosis:app:consumer:sink-mysql:verbose')('Insert row: %o', {
					// 	table: dbTable,
					// 	values: [rowData],
					// });

					// See if batch insert already has rows for current table and either add or append
					const tableIndex = batchInsertValues.findIndex(f => f.table === dbTable);

					if (tableIndex === -1) {
						batchInsertValues.push({
							table: dbTable,
							values: [rowData],
						});
					} else {
						batchInsertValues[tableIndex].values = [...batchInsertValues[tableIndex].values, rowData];
					}
				}

				// Run SQL inserts for every group of table + values
				// If the batch fails mid-loop, an exception will be thrown and none of the messages will be committed
				// TODO: Need to solve committing a partial batch if the first in a set of batchInsertValues successfully writes but future iterations fail
				for (const tableInserts of batchInsertValues) {
					const { table, values } = tableInserts;

					const { insert } = this.sinkMysqlConsumerOptions || {};

					const result = await this.database.insert(values, table, {
						...(insert && { insert }),
					});

					// debugVerbose('Result: ', result);
					Debug('metamorphosis:app:consumer:sink-mysql:verbose')('Insert Result: ', result);
					// TODO: On error re-insert failed messages to end of topic and allow the rest of the batch to finish??
				}
			},
		});

		return this;
	}
}
