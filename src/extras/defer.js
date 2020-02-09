function Deferred() {
    if (typeof Promise != "undefined" && Promise.defer) {
        return Promise.defer();
    } else {
        this.resolve = null;
        this.reject = null;
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        Object.freeze(this);
    }
}

module.exports = {
    Deferred
};
