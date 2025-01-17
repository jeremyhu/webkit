'use strict';

let assert = require('assert');

require('./v3-models.js');

class BuildbotBuildEntry {
    constructor(syncer, rawData)
    {
        assert.equal(syncer.builderName(), rawData['builderName']);

        this._syncer = syncer;
        this._slaveName = null;
        this._buildRequestId = null;
        this._isInProgress = rawData['currentStep'] || (rawData['times'] && !rawData['times'][1]);
        this._buildNumber = rawData['number'];

        for (let propertyTuple of (rawData['properties'] || [])) {
            // e.g. ['build_request_id', '16733', 'Force Build Form']
            let name = propertyTuple[0];
            let value = propertyTuple[1];
            if (name == syncer._slavePropertyName)
                this._slaveName = value;
            else if (name == syncer._buildRequestPropertyName)
                this._buildRequestId = value;
        }
    }

    buildNumber() { return this._buildNumber; }
    slaveName() { return this._slaveName; }
    buildRequestId() { return this._buildRequestId; }
    isPending() { return !this._buildNumber; }
    isInProgress() { return this._isInProgress; }
    hasFinished() { return !this.isPending() && !this.isInProgress(); }
    url() { return this.isPending() ? this._syncer.url() : this._syncer.urlForBuildNumber(this._buildNumber); }
}

class BuildbotSyncer {

    constructor(url, object)
    {
        this._url = url;
        this._builderName = object.builder;
        this._platformName = object.platform;
        this._testPath = object.test;
        this._propertiesTemplate = object.properties;
        this._slavePropertyName = object.slaveArgument;
        this._buildRequestPropertyName = object.buildRequestArgument;
    }

    testPath() { return this._testPath }
    builderName() { return this._builderName; }
    platformName() { return this._platformName; }

    pullBuildbot(count)
    {
        let self = this;
        return RemoteAPI.getJSON(this.urlForPendingBuildsJSON()).then(function (content) {
            let pendingEntries = content.map(function (entry) { return new BuildbotBuildEntry(self, entry); });

            return self._pullRecentBuilds(count).then(function (entries) {
                let entryByRequest = {};

                for (let entry of pendingEntries)
                    entryByRequest[entry.buildRequestId()] = entry;

                for (let entry of entries)
                    entryByRequest[entry.buildRequestId()] = entry;

                return entryByRequest;
            });
        });
    }

    _pullRecentBuilds(count)
    {
        if (!count)
            return Promise.resolve([]);

        let selectedBuilds = new Array(count);
        for (let i = 0; i < count; i++)
            selectedBuilds[i] = -i - 1;

        let self = this;
        return RemoteAPI.getJSON(this.urlForBuildJSON(selectedBuilds)).then(function (content) {
            let entries = [];
            for (let index of selectedBuilds) {
                let entry = content[index];
                if (entry && !entry['error'])
                    entries.push(new BuildbotBuildEntry(self, entry));
            }
            return entries;
        });
    }

    urlForPendingBuildsJSON() { return `${this._url}/json/builders/${this._builderName}/pendingBuilds`; }
    urlForBuildJSON(selectedBuilds)
    {
        return `${this._url}/json/builders/${this._builderName}/builds/?`
            + selectedBuilds.map(function (number) { return 'select=' + number; }).join('&');
    }

    url() { return `${this._url}/builders/${this._builderName}/`; }
    urlForBuildNumber(number) { return `${this._url}/builders/${this._builderName}/builds/${number}`; }

    _propertiesForBuildRequest(buildRequest)
    {
        console.assert(buildRequest instanceof BuildRequest);

        let rootSet = buildRequest.rootSet();
        console.assert(rootSet instanceof RootSet);

        let repositoryByName = {};
        for (let repository of rootSet.repositories())
            repositoryByName[repository.name()] = repository;

        let properties = {};
        for (let key in this._propertiesTemplate) {
            let value = this._propertiesTemplate[key];
            if (typeof(value) != 'object')
                properties[key] = value;
            else if ('root' in value) {
                let repositoryName = value['root'];
                let repository = repositoryByName[repositoryName];
                assert(repository, '"${repositoryName}" must be specified');
                properties[key] = rootSet.revisionForRepository(repository);
            } else if ('rootsExcluding' in value) {
                let revisionSet = this._revisionSetFromRootSetWithExclusionList(rootSet, value['rootsExcluding']);
                properties[key] = JSON.stringify(revisionSet);
            }
        }

        properties[this._buildRequestPropertyName] = buildRequest.id();

        return properties;
    }

    _revisionSetFromRootSetWithExclusionList(rootSet, exclusionList)
    {
        let revisionSet = {};
        for (let repository of rootSet.repositories()) {
            if (exclusionList.indexOf(repository.name()) >= 0)
                continue;
            let commit = rootSet.commitForRepository(repository);
            revisionSet[repository.name()] = {
                id: commit.id(),
                time: +commit.time(),
                repository: repository.name(),
                revision: commit.revision(),
            };
        }
        return revisionSet;
    }

    static _loadConfig(url, config)
    {
        let shared = config['shared'] || {};
        let types = config['types'] || {};
        let builders = config['builders'] || {};

        let syncers = [];
        for (let entry of config['configurations']) {
            let newConfig = {};
            this._validateAndMergeConfig(newConfig, shared);

            this._validateAndMergeConfig(newConfig, entry);

            let type = entry['type'];
            if (type) {
                assert(types[type]);
                this._validateAndMergeConfig(newConfig, types[type]);
            }

            let builder = entry['builder'];
            if (builders[builder])
                this._validateAndMergeConfig(newConfig, builders[builder]);

            assert('platform' in newConfig, 'configuration must specify a platform');
            assert('test' in newConfig, 'configuration must specify a test');
            assert('builder' in newConfig, 'configuration must specify a builder');
            assert('properties' in newConfig, 'configuration must specify arguments to post on a builder');
            assert('buildRequestArgument' in newConfig, 'configuration must specify buildRequestArgument');
            syncers.push(new BuildbotSyncer(url, newConfig));
        }

        return syncers;
    }

    static _validateAndMergeConfig(config, valuesToMerge)
    {
        for (let name in valuesToMerge) {
            let value = valuesToMerge[name];
            switch (name) {
            case 'arguments':
                assert.equal(typeof(value), 'object', 'arguments should be a dictionary');
                if (!config['properties'])
                    config['properties'] = {};
                this._validateAndMergeProperties(config['properties'], value);
                break;
            case 'test':
                assert(value instanceof Array, 'test should be an array');
                assert(value.every(function (part) { return typeof part == 'string'; }), 'test should be an array of strings');
                config[name] = value.slice();
                break;
            case 'type': // fallthrough
            case 'builder': // fallthrough
            case 'platform': // fallthrough
            case 'slaveArgument': // fallthrough
            case 'buildRequestArgument':
                assert.equal(typeof(value), 'string', `${name} should be of string type`);
                config[name] = value;
                break;
            default:
                assert(false, `Unrecognized parameter ${name}`);
            }
        }
    }

    static _validateAndMergeProperties(properties, configArguments)
    {
        for (let name in configArguments) {
            let value = configArguments[name];
            if (typeof(value) == 'string') {
                properties[name] = value;
                continue;
            }
            assert.equal(typeof(value), 'object', 'A argument value must be either a string or a dictionary');
                
            let keys = Object.keys(value);
            assert.equal(keys.length, 1, 'arguments value cannot contain more than one key');
            let namedValue = value[keys[0]];
            switch (keys[0]) {
            case 'root':
                assert.equal(typeof(namedValue), 'string', 'root name must be a string');
                break;
            case 'rootsExcluding':
                assert(namedValue instanceof Array, 'rootsExcluding must specify an array');
                for (let excludedRootName of namedValue)
                    assert.equal(typeof(excludedRootName), 'string', 'rootsExcluding must specify an array of strings');
                namedValue = namedValue.slice();
                break;
            default:
                assert(false, `Unrecognized named argument ${keys[0]}`);
            }
            properties[name] = {[keys[0]]: namedValue};
        }
    }

}

if (typeof module != 'undefined') {
    module.exports.BuildbotSyncer = BuildbotSyncer;
    module.exports.BuildbotBuildEntry = BuildbotBuildEntry;
}
